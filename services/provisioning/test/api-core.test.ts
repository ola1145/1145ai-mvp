import { describe, expect, it, vi } from 'vitest';
import { mintTenantToken } from '@1145/shared';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import {
  ddbOnboardingStore,
  makeHandler as makeBasics,
  mintOnboardingToken,
  normalizeWebsite,
  parseArea,
  verifyOnboardingToken,
  type OnboardingState,
  type OnboardingStore,
  type StoredBasics,
} from '../src/api/basics.js';
import { makeHandler as makeWaitlist } from '../src/api/waitlist.js';
import {
  makeHandler as makeProvisioning,
  sfnWorkflow,
  type ExecutionInfo,
  type HistoryEvent,
  type Workflow,
} from '../src/api/provisioning.js';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------------------------------------------

const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const OLD_SECRET = 'previous-signing-secret-fedcba9876543210';
const NOW = new Date('2026-10-06T15:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const ID = 'o_abc123def456';
const OTHER = 'o_zzz999yyy888';
const TENANT = 't_0123456789abcdef0123';

const tokenFor = (onboardingId: string, secret = SECRET, ttl = 300) => mintOnboardingToken(onboardingId, secret, ttl, NOW_SEC);

/** In-memory OnboardingStore with the same semantics as the DynamoDB one (first writer wins where it matters). */
function memoryStore(seed: Record<string, Partial<OnboardingState>> = { [ID]: { channel: 'webchat', channelUserId: 'sub-1' } }) {
  const states = new Map<string, OnboardingState>();
  for (const [id, s] of Object.entries(seed)) states.set(id, { onboardingId: id, status: 'started', ...s });
  const basics = new Map<string, StoredBasics>();
  const waitlist = new Map<string, { reason: string; detail?: string; at: string }>();
  const writes: string[] = [];
  const store: OnboardingStore = {
    async getState(id) { const s = states.get(id); return s && structuredClone(s); },
    async getBasics(id) { const b = basics.get(id); return b && structuredClone(b); },
    async putBasics(id, b) { writes.push(`basics:${id}`); basics.set(id, structuredClone(b)); },
    async markWaitlisted(id, entry) {
      writes.push(`waitlist:${id}`);
      const s = states.get(id); if (!s) throw new Error('no state');
      s.waitlisted = true; s.status = 'waitlisted'; s.waitlistReason ??= entry.reason;
      if (!waitlist.has(id)) waitlist.set(id, entry);
    },
    async ensureTenantId(id, candidate) {
      const s = states.get(id); if (!s) throw new Error('no state');
      s.tenantId ??= candidate; return s.tenantId;
    },
    async recordProvisioning(id, p) {
      writes.push(`provisioning:${id}`);
      const s = states.get(id); if (!s) throw new Error('no state');
      s.provisioning = p; s.status = 'provisioning';
    },
  };
  return { store, states, savedBasics: basics, waitlist, writes };
}

const arn = (name: string) => `arn:aws:states:us-east-1:111122223333:execution:Provisioning:${name}`;

/** Fake state machine with the semantics that matter: one execution per name, same name again returns it. */
function fakeWorkflow() {
  const executions = new Map<string, { input: Record<string, unknown>; status: ExecutionInfo['status']; output?: string }>();
  const histories = new Map<string, HistoryEvent[]>();
  const startCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const wf: Workflow & { executions: typeof executions; histories: typeof histories; startCalls: typeof startCalls; failHistory: boolean; failStart: boolean } = {
    executions, histories, startCalls, failHistory: false, failStart: false,
    async start(name, input) {
      startCalls.push({ name, input });
      if (wf.failStart) throw new Error('states unavailable');
      if (executions.has(name)) return { executionArn: arn(name), existed: true };
      executions.set(name, { input, status: 'RUNNING' });
      return { executionArn: arn(name), existed: false };
    },
    async describe(name) {
      const ex = executions.get(name);
      return ex ? { executionArn: arn(name), status: ex.status, ...(ex.output ? { output: ex.output } : {}) } : undefined;
    },
    async history(name) {
      if (wf.failHistory) throw new Error('AccessDeniedException');
      return histories.get(name) ?? [];
    },
  };
  return wf;
}

interface Req { method?: string; id?: string; path?: string; body?: unknown; token?: string | null; header?: string; param?: 'id' | 'onboardingId' }
function apiEvent(r: Req) {
  const id = r.id ?? ID;
  const token = r.token === undefined ? tokenFor(id) : r.token;
  return {
    rawPath: r.path ?? `/internal/onboarding/${id}/x`,
    pathParameters: { [r.param ?? 'id']: id },
    headers: token === null ? {} : { authorization: r.header ?? `Bearer ${token}` },
    requestContext: { http: { method: r.method ?? 'POST' } },
    body: r.body === undefined ? undefined : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    isBase64Encoded: false,
  };
}
const parse = (res: { statusCode: number; body: string }) => ({ status: res.statusCode, json: JSON.parse(res.body) as Record<string, any> });

function setup(seed?: Record<string, Partial<OnboardingState>>) {
  const mem = memoryStore(seed);
  const wf = fakeWorkflow();
  const deps = {
    store: mem.store,
    workflow: wf,
    tokenSecrets: async () => [SECRET, OLD_SECRET] as const,
    now: () => NOW,
    newTenantId: () => TENANT,
  };
  return {
    ...mem, wf,
    basics: (r: Req) => makeBasics(deps)(apiEvent({ path: `/internal/onboarding/${r.id ?? ID}/basics`, ...r })).then(parse),
    waitlistCall: (r: Req) => makeWaitlist(deps)(apiEvent({ path: `/internal/onboarding/${r.id ?? ID}/waitlist`, ...r })).then(parse),
    start: (r: Req = {}) => makeProvisioning(deps)(apiEvent({ path: `/internal/onboarding/${r.id ?? ID}/provisioning`, ...r })).then(parse),
    status: (r: Req = {}) => makeProvisioning(deps)(apiEvent({ method: 'GET', path: `/internal/onboarding/${r.id ?? ID}/provisioning`, ...r })).then(parse),
  };
}

const GOOD_BASICS = { businessName: 'Kemi Cuts', businessType: 'barber', area: 'Frisco, TX', website: 'kemicuts.com' };
const ready = { [ID]: { channel: 'webchat', channelUserId: 'sub-1' } } as const;

/** Save basics so the onboarding can start. */
async function withBasics(t: ReturnType<typeof setup>, body: Record<string, unknown> = GOOD_BASICS) {
  const r = await t.basics({ body });
  expect(r.status).toBe(200);
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Service-token auth; onboardingId from the path must match the token claim
// ---------------------------------------------------------------------------------------------------------------

describe('onboarding service token', () => {
  it('round-trips and carries the onboarding id as a claim', () => {
    const claims = verifyOnboardingToken(tokenFor(ID), [SECRET], NOW_SEC);
    expect(claims).toMatchObject({ onb: ID, aud: 'onboarding-api', iat: NOW_SEC, exp: NOW_SEC + 300 });
  });

  it('rejects bad signatures, expired tokens, long-lived tokens, wrong audience and alg none', () => {
    expect(() => verifyOnboardingToken(tokenFor(ID, 'some-other-secret-entirely-0123456789'), [SECRET], NOW_SEC)).toThrow();
    expect(() => verifyOnboardingToken(tokenFor(ID), [SECRET], NOW_SEC + 301)).toThrow(/expired/);
    expect(() => verifyOnboardingToken(tokenFor(ID, SECRET, 24 * 3600), [SECRET], NOW_SEC)).toThrow(/lifetime/);
    const tool = mintTenantToken({ tid: ID, prn: 'owner' }, SECRET, 300, NOW_SEC);
    expect(() => verifyOnboardingToken(tool, [SECRET], NOW_SEC)).toThrow();
    const [, payload] = tokenFor(ID).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    expect(() => verifyOnboardingToken(none, [SECRET], NOW_SEC)).toThrow();
    expect(() => verifyOnboardingToken('not-a-token', [SECRET], NOW_SEC)).toThrow();
  });

  const calls: Array<[string, (t: ReturnType<typeof setup>, r: Req) => Promise<{ status: number; json: Record<string, any> }>, Req]> = [
    ['POST basics', (t, r) => t.basics(r), { body: GOOD_BASICS }],
    ['POST waitlist', (t, r) => t.waitlistCall(r), { body: { reason: 'healthcare' } }],
    ['POST provisioning', (t, r) => t.start(r), { body: {} }],
    ['GET provisioning', (t, r) => t.status(r), {}],
  ];

  describe.each(calls)('%s', (_name, call, base) => {
    const fresh = async () => withBasics(setup({ [ID]: { ...ready[ID] }, [OTHER]: { channel: 'webchat', channelUserId: 'sub-2' } }));

    it('answers 401 without touching anything when the token is missing or malformed', async () => {
      const t = await fresh(); const before = t.writes.length;
      for (const bad of [{ token: null }, { header: 'Basic abc' }, { header: 'Bearer' }, { header: 'Bearer not.a.jwt' }, { header: `Bearer ${tokenFor(ID, 'wrong-secret-wrong-secret-wrong-12')}` }]) {
        const r = await call(t, { ...base, ...bad });
        expect(r.status).toBe(401);
        expect(r.json.code).toBe('unauthorized');
      }
      expect(t.writes.length).toBe(before);
      expect(t.wf.startCalls).toEqual([]);
    });

    it('answers 401 for an expired token and for a tool-api tenant token signed with the same key', async () => {
      const t = await fresh(); const before = t.writes.length;
      const expired = mintOnboardingToken(ID, SECRET, 60, NOW_SEC - 3600);
      expect((await call(t, { ...base, token: expired })).status).toBe(401);
      const tenantTok = mintTenantToken({ tid: TENANT, prn: 'owner' }, SECRET, 300, NOW_SEC);
      expect((await call(t, { ...base, token: tenantTok })).status).toBe(401);
      expect(t.writes.length).toBe(before);
    });

    it('answers 403 when the token is for a different onboarding than the path, and does nothing', async () => {
      const t = await fresh(); const before = t.writes.length;
      const r = await call(t, { ...base, token: tokenFor(OTHER) }); // valid token, but for OTHER; the path says ID
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('forbidden');
      expect(t.writes.length).toBe(before);
      expect(t.wf.startCalls).toEqual([]);
    });

    it('accepts the matching token, including one signed with the previous key (rotation)', async () => {
      const t = await fresh();
      for (const token of [tokenFor(ID), tokenFor(ID, OLD_SECRET)]) {
        const r = await call(t, { ...base, token });
        expect([401, 403]).not.toContain(r.status);
        expect(r.status).toBeLessThan(500);
      }
    });

    it('reads the id from the route parameter the stack uses ({id}) or the contract name ({onboardingId})', async () => {
      const t = await fresh();
      for (const param of ['id', 'onboardingId'] as const) {
        const r = await call(t, { ...base, param });
        expect([401, 403, 400]).not.toContain(r.status);
      }
    });
  });

  it('never takes the onboarding or tenant id from the body', async () => {
    const t = setup({ [ID]: { ...ready[ID] }, [OTHER]: { channel: 'webchat', channelUserId: 'sub-2' } });
    const r = await t.basics({ body: { ...GOOD_BASICS, onboardingId: OTHER, tenantId: 't_attackerattacker1' } });
    expect(r.status).toBe(200);
    expect(t.writes).toEqual([`basics:${ID}`]);
    expect(t.states.get(OTHER)?.tenantId).toBeUndefined();
  });

  it('rejects a path id that could never be a real onboarding id', async () => {
    const t = setup();
    for (const id of ['a#b', 'x'.repeat(100), 'a b']) {
      const r = await t.basics({ id, token: tokenFor(id), body: GOOD_BASICS });
      expect(r.status).toBe(400);
    }
  });

  it('fails closed when the signing keys cannot be loaded', async () => {
    const mem = memoryStore();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeBasics({ store: mem.store, tokenSecrets: async () => { throw new Error('secrets down'); }, now: () => NOW });
    const res = await handler(apiEvent({ body: GOOD_BASICS }));
    log.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(mem.writes).toEqual([]);
  });

  it('refuses to run with no keys at all, or with a key too short to mean anything', async () => {
    const mem = memoryStore();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const secrets of [[], [''], ['short']]) {
      const handler = makeBasics({ store: mem.store, tokenSecrets: async () => secrets, now: () => NOW });
      expect((await handler(apiEvent({ body: GOOD_BASICS, token: mintOnboardingToken(ID, secrets[0] ?? 'x', 300, NOW_SEC) }))).statusCode).toBe(500);
    }
    log.mockRestore();
    expect(mem.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Basics
// ---------------------------------------------------------------------------------------------------------------

describe('area parsing', () => {
  it.each([
    ['Frisco, TX', { state: 'TX' }],
    ['Frisco TX', { state: 'TX' }],
    ['frisco, tx', { state: 'TX' }],
    ['Frisco, Texas', { state: 'TX' }],
    ['Miami FL 33101', { state: 'FL' }],
    ['Portland, OR', { state: 'OR' }],
    ['Kansas City, MO', { state: 'MO' }],
    ['Kansas City, Kansas', { state: 'KS' }],
    ['Charlotte, North Carolina', { state: 'NC' }],
    ['Charleston, West Virginia', { state: 'WV' }],
    ['Washington, DC', { state: 'DC' }],
    ['214', { areaCode: '214' }],
    ['area code 972, Texas', { areaCode: '972', state: 'TX' }],
    ['Plano (469)', { areaCode: '469' }],
    ['Frisco', {}],
    ['Dallas area', {}],
    ['Kansas City', {}],
    ['Portland or Seattle', {}],
    ['Highway 380 near Frisco', {}],
    ['Austin 78701', {}],
    ['Suite 100, Frisco', {}],
    ['', {}],
  ])('%j -> %j', (text, expected) => {
    expect(parseArea(text)).toEqual(expected);
  });
});

describe('website normalisation', () => {
  it.each([
    ['kemicuts.com', 'https://kemicuts.com/'],
    ['www.kemicuts.com/menu', 'https://www.kemicuts.com/menu'],
    ['http://kemicuts.com', 'http://kemicuts.com/'],
    ['  https://KemiCuts.com  ', 'https://kemicuts.com/'],
  ])('keeps %j as %j', (raw, expected) => expect(normalizeWebsite(raw)).toBe(expected));

  it.each([
    'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'localhost', 'http://127.0.0.1/admin',
    'http://10.0.0.5', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'not a url', 'https://user:pw@example.com',
    'http://intranet', `https://example.com/${'a'.repeat(400)}`, '', '   ',
  ])('drops %j', (raw) => expect(normalizeWebsite(raw)).toBeUndefined());

  it.each([null, undefined, 42, {}])('drops %j', (raw) => expect(normalizeWebsite(raw as unknown)).toBeUndefined());
});

describe('POST basics', () => {
  it('saves the basics and says what area it could resolve', async () => {
    const t = setup();
    const r = await t.basics({ body: GOOD_BASICS });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ saved: true, areaResolved: true });
    expect(r.json.error).toBeUndefined(); // the agent's API wrapper treats any "error" key as a failure
    expect(t.savedBasics.get(ID)).toMatchObject({
      businessName: 'Kemi Cuts', businessType: 'barber', areaText: 'Frisco, TX', area: { state: 'TX' }, website: 'https://kemicuts.com/',
    });
  });

  it('saves with areaResolved false when the city has no state, and keeps what they said', async () => {
    const t = setup();
    const r = await t.basics({ body: { ...GOOD_BASICS, area: 'Frisco' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ saved: true, areaResolved: false });
    expect(t.savedBasics.get(ID)?.areaText).toBe('Frisco');
    expect(t.savedBasics.get(ID)?.area).toEqual({});
  });

  it('cleans owner text: control characters, runs of whitespace, and length', async () => {
    const t = setup();
    await t.basics({ body: { businessName: '  Kemi\u0000   Cuts \n‮ ', businessType: ' Barber   shop ', area: 'Frisco,\tTX', website: null } });
    const b = t.savedBasics.get(ID)!;
    expect(b.businessName).toBe('Kemi Cuts');
    expect(b.businessType).toBe('Barber shop');
    expect(b.areaText).toBe('Frisco, TX');
    expect(b.website).toBeUndefined();
    await t.basics({ body: { businessName: 'N'.repeat(500), businessType: 't'.repeat(200), area: 'a'.repeat(300) } });
    expect(t.savedBasics.get(ID)!.businessName.length).toBe(120);
    expect(t.savedBasics.get(ID)!.businessType.length).toBe(60);
    expect(t.savedBasics.get(ID)!.areaText.length).toBe(100);
  });

  it('drops a website that is not a public http(s) address instead of failing the save', async () => {
    const t = setup();
    const r = await t.basics({ body: { ...GOOD_BASICS, website: 'http://169.254.169.254/latest' } });
    expect(r.status).toBe(200);
    expect(t.savedBasics.get(ID)?.website).toBeUndefined();
  });

  it('is idempotent and lets the owner correct themselves', async () => {
    const t = setup();
    await t.basics({ body: GOOD_BASICS });
    await t.basics({ body: GOOD_BASICS });
    expect(t.savedBasics.size).toBe(1);
    await t.basics({ body: { ...GOOD_BASICS, businessName: 'Kemi Cuts & Co', area: 'Plano, TX' } });
    expect(t.savedBasics.get(ID)).toMatchObject({ businessName: 'Kemi Cuts & Co', areaText: 'Plano, TX' });
  });

  it.each([
    [{}], [{ businessName: 'x' }], [{ businessName: '', businessType: 'barber', area: 'Frisco' }],
    [{ businessName: 'x', businessType: 'barber' }], [{ businessName: 42, businessType: 'barber', area: 'Frisco' }],
    [{ businessName: '\u0000 \u0001', businessType: 'barber', area: 'Frisco' }],
  ])('rejects %j with a code the agent can read', async (body) => {
    const t = setup();
    const r = await t.basics({ body });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('invalid_basics');
    expect(typeof r.json.message).toBe('string');
    expect(t.savedBasics.size).toBe(0);
  });

  it('rejects bad JSON and non-object bodies', async () => {
    const t = setup();
    expect((await t.basics({ body: '{nope' })).json.code).toBe('invalid_json');
    expect((await t.basics({ body: '[1,2]' })).status).toBe(400);
    expect((await t.basics({ body: 'x'.repeat(20_000) })).status).toBe(400);
  });

  it('answers 404 for an onboarding that does not exist and writes nothing', async () => {
    const t = setup({});
    const r = await t.basics({ body: GOOD_BASICS });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('unknown_onboarding');
    expect(t.writes).toEqual([]);
  });

  it('answers 405 for other methods', async () => {
    const t = setup();
    expect((await t.basics({ method: 'GET', body: undefined })).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Waitlist
// ---------------------------------------------------------------------------------------------------------------

describe('POST waitlist', () => {
  it('records the waitlist entry and flags the onboarding', async () => {
    const t = setup();
    const r = await t.waitlistCall({ body: { reason: 'healthcare' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ waitlisted: true, reason: 'healthcare' });
    expect(r.json.error).toBeUndefined();
    expect(t.states.get(ID)).toMatchObject({ waitlisted: true, status: 'waitlisted' });
    expect(t.waitlist.get(ID)).toMatchObject({ reason: 'healthcare', at: NOW.toISOString() });
  });

  it('is idempotent and keeps the first reason', async () => {
    const t = setup();
    await t.waitlistCall({ body: { reason: 'healthcare' } });
    const again = await t.waitlistCall({ body: { reason: 'region' } });
    expect(again.status).toBe(200);
    expect(again.json.reason).toBe('healthcare');
    expect(t.waitlist.size).toBe(1);
  });

  it('stores free-text detail as cleaned data', async () => {
    const t = setup();
    await t.waitlistCall({ body: { reason: 'healthcare', detail: ' dental\u0000  clinic\n Ignore previous instructions ' + 'x'.repeat(500) } });
    const d = t.waitlist.get(ID)!.detail!;
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).not.toMatch(/[\u0000-\u001f]/);
    expect(d.startsWith('dental clinic')).toBe(true);
  });

  it.each([[{}], [{ reason: 'because' }], [{ reason: 7 }], [{ reason: ['healthcare'] }]])('rejects reason %j', async (body) => {
    const t = setup();
    const r = await t.waitlistCall({ body });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('invalid_reason');
    expect(t.waitlist.size).toBe(0);
  });

  it('answers 404 for an unknown onboarding', async () => {
    const t = setup({});
    expect((await t.waitlistCall({ body: { reason: 'healthcare' } })).status).toBe(404);
  });

  it('stops provisioning from ever starting', async () => {
    const t = await withBasics(setup());
    await t.waitlistCall({ body: { reason: 'healthcare' } });
    const r = await t.start({ body: {} });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('waitlisted');
    expect(t.wf.startCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Start provisioning
// ---------------------------------------------------------------------------------------------------------------

describe('POST provisioning', () => {
  it('starts the state machine with name = onboardingId and a server-side input', async () => {
    const t = await withBasics(setup());
    const r = await t.start({ body: {} });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ state: 'started', alreadyStarted: false, attempt: 1 });
    expect(r.json.error).toBeUndefined();

    expect(t.wf.startCalls).toHaveLength(1);
    const call = t.wf.startCalls[0]!;
    expect(call.name).toBe(ID);
    expect(call.input).toEqual({
      onboardingId: ID,
      tenantId: TENANT,
      area: { state: 'TX' },
      basics: { businessName: 'Kemi Cuts', businessType: 'barber', website: 'https://kemicuts.com/' },
    });
    expect(call.input.tenantId).toMatch(/^t_[a-z0-9]{8,40}$/);
    expect(t.states.get(ID)).toMatchObject({ tenantId: TENANT, status: 'provisioning', provisioning: { executionName: ID, attempt: 1, startedAt: NOW.toISOString() } });
  });

  it('a second call returns the existing execution and starts nothing new', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    const again = await t.start({ body: { preferredAreaCode: '972' } }); // different input must not matter
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ state: 'running', alreadyStarted: true });
    expect(t.wf.executions.size).toBe(1);
    expect(t.wf.startCalls).toHaveLength(1);
    expect(t.states.get(ID)?.tenantId).toBe(TENANT);
  });

  it('survives a crash between StartExecution and saving the record: same name, same execution', async () => {
    const t = await withBasics(setup());
    t.wf.executions.set(ID, { input: {}, status: 'RUNNING' }); // the earlier call started it, then the Lambda died
    const r = await t.start({ body: {} });
    expect(r.status).toBe(200);
    expect(r.json.alreadyStarted).toBe(true);
    expect(t.wf.executions.size).toBe(1);
    expect(t.states.get(ID)?.provisioning).toMatchObject({ executionName: ID, attempt: 1 }); // record repaired
  });

  it('two simultaneous first calls end with one execution and one tenant id', async () => {
    const t = await withBasics(setup());
    const [a, b] = await Promise.all([t.start({ body: {} }), t.start({ body: {} })]);
    expect([a.status, b.status].every((s) => s === 200 || s === 202)).toBe(true);
    expect(t.wf.executions.size).toBe(1);
    expect(new Set(t.wf.startCalls.map((c) => c.input.tenantId)).size).toBe(1);
  });

  it('never uses a tenant id, execution name or area from the request body', async () => {
    const t = await withBasics(setup());
    await t.start({ body: { tenantId: 't_attackerattacker1', onboardingId: OTHER, name: 'mine', area: { state: 'NY' }, executionName: 'x' } });
    const call = t.wf.startCalls[0]!;
    expect(call.name).toBe(ID);
    expect(call.input.tenantId).toBe(TENANT);
    expect(call.input.area).toEqual({ state: 'TX' });
  });

  it('answers 409 identity_not_confirmed until the reverse confirmation is done', async () => {
    const t = await withBasics(setup({ [ID]: { channel: 'telegram', channelUserId: '99', identityStatus: 'pending' } }));
    const r = await t.start({ body: {} });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('identity_not_confirmed'); // agents/common/api.py turns `code` into the tool's error
    expect(typeof r.json.message).toBe('string');
    expect(t.wf.startCalls).toEqual([]);
    expect(t.states.get(ID)?.tenantId).toBeUndefined();

    const none = await withBasics(setup({ [ID]: { channel: 'telegram', channelUserId: '99' } }));
    expect((await none.start({ body: {} })).json.code).toBe('identity_not_confirmed');
  });

  it('starts for a Telegram owner once the binding is confirmed, and for web chat (already signed in)', async () => {
    const tg = await withBasics(setup({ [ID]: { channel: 'telegram', channelUserId: '99', identityStatus: 'confirmed' } }));
    expect((await tg.start({ body: {} })).status).toBe(202);
    const web = await withBasics(setup({ [ID]: { channel: 'webchat', channelUserId: 'sub-1' } }));
    expect((await web.start({ body: {} })).status).toBe(202);
  });

  it('answers 409 basics_missing before anything is started', async () => {
    const t = setup();
    const r = await t.start({ body: {} });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('basics_missing');
    expect(t.wf.startCalls).toEqual([]);
  });

  it('answers 422 area_needed when neither a state nor an area code is known, and a preferred area code fixes it', async () => {
    const t = await withBasics(setup(), { ...GOOD_BASICS, area: 'Frisco' });
    const r = await t.start({ body: {} });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('area_needed');
    expect(t.wf.startCalls).toEqual([]);

    const ok = await t.start({ body: { preferredAreaCode: '(214)' } });
    expect(ok.status).toBe(202);
    expect(t.wf.startCalls[0]!.input.area).toEqual({ areaCode: '214' });
  });

  it('puts a valid preferred area code first and keeps the state as the fallback; ignores junk', async () => {
    const good = await withBasics(setup());
    await good.start({ body: { preferredAreaCode: '972' } });
    expect(good.wf.startCalls[0]!.input.area).toEqual({ areaCode: '972', state: 'TX' });

    for (const junk of ['abc', '123', '21', '2144', '+1 214', '; drop table', 42, null]) {
      const t = await withBasics(setup());
      await t.start({ body: { preferredAreaCode: junk } });
      expect(t.wf.startCalls[0]!.input.area).toEqual({ state: 'TX' });
    }
  });

  it('starts again under a new attempt name only after the earlier execution failed', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    t.wf.executions.get(ID)!.status = 'FAILED';
    const second = await t.start({ body: {} });
    expect(second.status).toBe(202);
    expect(second.json).toMatchObject({ state: 'started', alreadyStarted: false, attempt: 2 });
    expect(t.wf.startCalls.map((c) => c.name)).toEqual([ID, `${ID}.2`]);
    expect(t.states.get(ID)?.provisioning).toMatchObject({ executionName: `${ID}.2`, attempt: 2 });
    expect(t.states.get(ID)?.tenantId).toBe(TENANT); // same tenant, so the ORDER# record still protects the purchase

    // a run that was caught by NotifyFailure ends SUCCEEDED but carries an error: that is a failure too
    t.wf.executions.get(`${ID}.2`)!.status = 'SUCCEEDED';
    t.wf.executions.get(`${ID}.2`)!.output = JSON.stringify({ onboardingId: ID, error: { Error: 'NoNumberAvailable', Cause: 'none' } });
    const third = await t.start({ body: {} });
    expect(third.status).toBe(202);
    expect(t.wf.startCalls.map((c) => c.name)).toEqual([ID, `${ID}.2`, `${ID}.3`]);
  });

  it('gives up after three attempts instead of looping', async () => {
    const t = await withBasics(setup());
    for (let i = 0; i < 3; i++) {
      await t.start({ body: {} });
      for (const ex of t.wf.executions.values()) ex.status = 'TIMED_OUT';
    }
    const r = await t.start({ body: {} });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('provisioning_failed');
    expect(t.wf.startCalls).toHaveLength(3);
  });

  it('does not restart a run that finished fine', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    t.wf.executions.get(ID)!.status = 'SUCCEEDED';
    t.wf.executions.get(ID)!.output = JSON.stringify({ onboardingId: ID, activation: { ok: true } });
    const r = await t.start({ body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'done', alreadyStarted: true });
    expect(t.wf.startCalls).toHaveLength(1);
  });

  it('answers 503 when Step Functions cannot be asked about an earlier run', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.wf.describe = async () => { throw new Error('states unavailable'); };
    const r = await t.start({ body: {} });
    log.mockRestore();
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('unavailable');
    expect(t.wf.startCalls).toHaveLength(1);
  });

  it('answers 503 and records nothing as started when Step Functions is down, so a retry works', async () => {
    const t = await withBasics(setup());
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.wf.failStart = true;
    const r = await t.start({ body: {} });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('unavailable');
    expect(t.states.get(ID)?.provisioning).toBeUndefined();
    t.wf.failStart = false;
    expect((await t.start({ body: {} })).status).toBe(202);
    log.mockRestore();
  });

  it('answers 404 for an unknown onboarding', async () => {
    const t = setup({});
    expect((await t.start({ body: {} })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The Step Functions adapter
// ---------------------------------------------------------------------------------------------------------------

describe('sfnWorkflow', () => {
  const SM = 'arn:aws:states:us-east-1:111122223333:stateMachine:Provisioning';
  const named = (name: string, message = name) => Object.assign(new Error(message), { name });

  function fakeClient(handlers: Record<string, (input: any) => any>) {
    const sent: Array<{ type: string; input: any }> = [];
    return {
      sent,
      send: async (cmd: { constructor: { name: string }; input: any }) => {
        sent.push({ type: cmd.constructor.name, input: cmd.input });
        const h = handlers[cmd.constructor.name];
        if (!h) throw new Error(`unexpected ${cmd.constructor.name}`);
        return h(cmd.input);
      },
    };
  }

  it('StartExecution uses the name as given and the input as JSON', async () => {
    const c = fakeClient({ StartExecutionCommand: (i) => ({ executionArn: arn(i.name) }) });
    const r = await sfnWorkflow(c, SM).start(ID, { onboardingId: ID });
    expect(r).toEqual({ executionArn: arn(ID), existed: false });
    expect(c.sent[0]).toEqual({ type: 'StartExecutionCommand', input: { stateMachineArn: SM, name: ID, input: JSON.stringify({ onboardingId: ID }) } });
  });

  it('ExecutionAlreadyExists means "return the existing one", not an error', async () => {
    const c = fakeClient({ StartExecutionCommand: () => { throw named('ExecutionAlreadyExists'); } });
    const r = await sfnWorkflow(c, SM).start(ID, {});
    expect(r).toEqual({ executionArn: arn(ID), existed: true });
  });

  it('other StartExecution errors surface', async () => {
    const c = fakeClient({ StartExecutionCommand: () => { throw named('ThrottlingException', 'slow down'); } });
    await expect(sfnWorkflow(c, SM).start(ID, {})).rejects.toThrow('slow down');
  });

  it('describe maps the execution, and a missing one is undefined', async () => {
    const c = fakeClient({ DescribeExecutionCommand: (i) => {
      if (i.executionArn.endsWith(':gone')) throw named('ExecutionDoesNotExist');
      return { executionArn: i.executionArn, status: 'SUCCEEDED', output: '{"a":1}', startDate: NOW };
    } });
    const wf = sfnWorkflow(c, SM);
    expect(await wf.describe(ID)).toMatchObject({ executionArn: arn(ID), status: 'SUCCEEDED', output: '{"a":1}' });
    expect(await wf.describe('gone')).toBeUndefined();
  });

  it('history follows nextToken and stops at a sane page limit', async () => {
    let page = 0;
    const c = fakeClient({ GetExecutionHistoryCommand: (i) => {
      page += 1;
      return { events: [{ id: page, type: 'TaskStateEntered' }], ...(page < 3 ? { nextToken: `p${page}` } : {}), _in: i };
    } });
    const events = await sfnWorkflow(c, SM).history(ID);
    expect(events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(c.sent[1]!.input.nextToken).toBe('p1');
    expect(c.sent[0]!.input).toMatchObject({ executionArn: arn(ID), includeExecutionData: true });

    let n = 0;
    const endless = fakeClient({ GetExecutionHistoryCommand: () => ({ events: [{ id: ++n, type: 'x' }], nextToken: 'more' }) });
    expect((await sfnWorkflow(endless, SM).history(ID)).length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Status
// ---------------------------------------------------------------------------------------------------------------

/** Builds a history the way Step Functions records it: every event points at the one before it in the same state. */
class History {
  readonly events: HistoryEvent[] = [];
  private id = 0;
  private last = new Map<string, number>();
  private push(type: string, state: string, extra: Partial<HistoryEvent>): this {
    const prev = this.last.get(state) ?? this.id;
    const e: HistoryEvent = { id: ++this.id, previousEventId: prev, type, ...extra };
    this.events.push(e); this.last.set(state, e.id);
    return this;
  }
  enter(name: string, type = 'TaskStateEntered'): this { return this.push(type, name, { stateEnteredEventDetails: { name, input: '{}' } }); }
  exit(name: string, output: unknown = {}, type = 'TaskStateExited'): this { return this.push(type, name, { stateExitedEventDetails: { name, output: JSON.stringify(output) } }); }
  fail(name: string, error: string): this { return this.push('LambdaFunctionFailed', name, { lambdaFunctionFailedEventDetails: { error, cause: `${error} happened` } }); }
  timeout(name: string): this { return this.push('TaskTimedOut', name, { taskTimedOutEventDetails: { error: 'States.Timeout' } }); }
  retry(name: string): this { return this.push('LambdaFunctionScheduled', name, {}); }
  pass(name: string): this { return this.push('PassStateEntered', name, { stateEnteredEventDetails: { name, input: '{}' } }); }
}

const WITH_NUMBER = { number: { binding: { number: '+14695550142', engine: 'livekit-telnyx', agentId: `frontdesk:${TENANT}` } } };

async function statusFor(h: History | undefined, exec: { status: ExecutionInfo['status']; output?: unknown }, seed?: Partial<OnboardingState>) {
  const t = await withBasics(setup(seed ? { [ID]: { ...ready[ID], ...seed } } : undefined));
  await t.start({ body: {} });
  const ex = t.wf.executions.get(ID)!;
  ex.status = exec.status;
  if (exec.output !== undefined) ex.output = JSON.stringify(exec.output);
  if (h) t.wf.histories.set(ID, h.events);
  return { t, res: await t.status() };
}

const stepOf = (json: Record<string, any>, step: string) => (json.steps as Array<Record<string, any>>).find((s) => s.step === step);
const lines = (json: Record<string, any>) => json.progress as string[];

describe('GET provisioning', () => {
  it('says not started before provisioning begins', async () => {
    const t = await withBasics(setup());
    const r = await t.status();
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('not_started');
    expect(r.json.testCall).toBe('pending');
    expect(r.json.error).toBeUndefined();
    expect(t.wf.startCalls).toEqual([]);
  });

  it('merges the three build branches into plain-language progress lines (mid-run)', async () => {
    const h = new History()
      .enter('CheckPaymentMethod').exit('CheckPaymentMethod')
      .enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').exit('SearchNumber').enter('OrderNumber')
      .enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed')
      .enter('AwaitProfileComplete');
    const { res } = await statusFor(h, { status: 'RUNNING' });
    expect(res.status).toBe(200);
    expect(res.json.state).toBe('running');
    expect(stepOf(res.json, 'number')).toMatchObject({ state: 'started', messageForOwner: 'Grabbing your number now.' });
    expect(stepOf(res.json, 'knowledge')).toMatchObject({ state: 'waiting_owner', messageForOwner: 'A few things from your website are waiting on your OK.' });
    expect(stepOf(res.json, 'profile')).toMatchObject({ state: 'waiting_owner', messageForOwner: 'Waiting on your hours and services.' });
    expect(stepOf(res.json, 'agent_name')).toMatchObject({ state: 'pending' });
    expect(stepOf(res.json, 'payment')).toBeUndefined(); // card is on file: nothing to say
    expect(lines(res.json)).toEqual([
      'Grabbing your number now.',
      'A few things from your website are waiting on your OK.',
      'Waiting on your hours and services.',
    ]);
    expect(res.json.number).toBeUndefined(); // not bound yet: never hand out a number that is not live
    expect(res.json.testCall).toBe('pending');
    expect(res.json.waitingOn).toEqual(['facts', 'hours_and_services']);
  });

  it('is waiting_on_owner when only the owner is holding things up, and hands over the number once it is bound', async () => {
    const h = new History()
      .enter('CheckPaymentMethod').exit('CheckPaymentMethod')
      .enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').exit('OrderNumber').enter('BindEngine').exit('BindEngine', WITH_NUMBER)
      .enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed')
      .enter('AwaitProfileComplete');
    const { res } = await statusFor(h, { status: 'RUNNING' });
    expect(res.json.state).toBe('waiting_on_owner');
    expect(stepOf(res.json, 'number')).toMatchObject({ state: 'done', messageForOwner: 'Your new number is ready.' });
    expect(res.json.number).toBe('+14695550142');
    expect(res.json.numberDisplay).toBe('(469) 555-0142');
    expect(res.json.waitingOn).toEqual(['facts', 'hours_and_services']);
  });

  it('walks the number branch step by step in plain words', async () => {
    const base = () => new History().enter('CheckPaymentMethod').exit('CheckPaymentMethod').enter('Build', 'ParallelStateEntered');
    const a = await statusFor(base().enter('SearchNumber'), { status: 'RUNNING' });
    expect(stepOf(a.res.json, 'number')?.messageForOwner).toBe('Looking for a local number near you.');
    const b = await statusFor(base().enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').exit('OrderNumber').enter('BindEngine'), { status: 'RUNNING' });
    expect(stepOf(b.res.json, 'number')?.messageForOwner).toBe('Hooking your number up to the receptionist.');
    expect(b.res.json.number).toBeUndefined();
  });

  it('after the build: naming, test call and going live', async () => {
    const build = () => new History()
      .enter('CheckPaymentMethod').exit('CheckPaymentMethod')
      .enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').exit('OrderNumber').enter('BindEngine').exit('BindEngine', WITH_NUMBER)
      .enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed').exit('AwaitFactsConfirmed')
      .enter('AwaitProfileComplete').exit('AwaitProfileComplete')
      .exit('Build', WITH_NUMBER, 'ParallelStateExited');

    const rendering = await statusFor(build().enter('RenderAgent'), { status: 'RUNNING' });
    expect(stepOf(rendering.res.json, 'agent_name')?.messageForOwner).toBe("Writing your receptionist's instructions.");
    expect(rendering.res.json.state).toBe('running');

    const naming = await statusFor(build().enter('RenderAgent').exit('RenderAgent').enter('AwaitAgentName'), { status: 'RUNNING' });
    expect(stepOf(naming.res.json, 'agent_name')).toMatchObject({ state: 'waiting_owner', messageForOwner: 'Waiting on a name for your receptionist.' });
    expect(naming.res.json.state).toBe('waiting_on_owner');
    expect(naming.res.json.waitingOn).toEqual(['agent_name']);
    expect(stepOf(naming.res.json, 'knowledge')).toMatchObject({ state: 'done' });

    const testing = await statusFor(build().enter('RenderAgent').exit('RenderAgent').enter('AwaitAgentName').exit('AwaitAgentName').enter('SmokeCall'), { status: 'RUNNING' });
    expect(testing.res.json.testCall).toBe('queued');
    expect(stepOf(testing.res.json, 'smoke_call')?.messageForOwner).toBe('Calling your phone for a quick test.');

    const live = build().enter('RenderAgent').exit('RenderAgent').enter('AwaitAgentName').exit('AwaitAgentName').enter('SmokeCall').exit('SmokeCall').enter('ActivateTenant').exit('ActivateTenant');
    const done = await statusFor(live, { status: 'SUCCEEDED', output: { onboardingId: ID, ...WITH_NUMBER, activation: { ok: true } } });
    expect(done.res.json.state).toBe('done');
    expect(done.res.json.testCall).toBe('done');
    expect(done.res.json.numberDisplay).toBe('(469) 555-0142');
    expect(stepOf(done.res.json, 'activate')).toMatchObject({ state: 'done', messageForOwner: 'Your receptionist is live.' });
    expect(done.res.json.steps.every((s: any) => s.state === 'done')).toBe(true);
  });

  it('a failure in the number branch is named, and the branches that were only waiting are not blamed', async () => {
    const h = new History()
      .enter('CheckPaymentMethod').exit('CheckPaymentMethod')
      .enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').fail('SearchNumber', 'NoNumberAvailable')
      .enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed')
      .enter('AwaitProfileComplete')
      .pass('NotifyFailure');
    const { res } = await statusFor(h, { status: 'SUCCEEDED', output: { onboardingId: ID, error: { Error: 'NoNumberAvailable', Cause: 'none' } } });
    expect(res.json.state).toBe('failed');
    expect(stepOf(res.json, 'number')).toMatchObject({ state: 'failed', messageForOwner: "I couldn't find a number near you this time." });
    expect(stepOf(res.json, 'knowledge')).toMatchObject({ state: 'stopped', messageForOwner: 'Paused for now.' });
    expect(stepOf(res.json, 'profile')).toMatchObject({ state: 'stopped' });
    expect(lines(res.json)).toEqual(["I couldn't find a number near you this time."]);
    expect(res.json.number).toBeUndefined();
    expect(res.json.waitingOn).toEqual([]);
  });

  it('a failure that Step Functions is still retrying is not reported as failed', async () => {
    const h = new History()
      .enter('CheckPaymentMethod').exit('CheckPaymentMethod')
      .enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').fail('OrderNumber', 'TelnyxTransientError').retry('OrderNumber');
    const { res } = await statusFor(h, { status: 'RUNNING' });
    expect(stepOf(res.json, 'number')).toMatchObject({ state: 'started', messageForOwner: 'Grabbing your number now.' });
    expect(res.json.state).toBe('running');
  });

  it('a failed execution with an unexpected error gets a plain generic line', async () => {
    const h = new History().enter('CheckPaymentMethod').exit('CheckPaymentMethod').enter('Build', 'ParallelStateEntered')
      .enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').fail('OrderNumber', 'States.Runtime');
    const { res } = await statusFor(h, { status: 'FAILED' });
    expect(res.json.state).toBe('failed');
    expect(stepOf(res.json, 'number')).toMatchObject({ state: 'failed', messageForOwner: 'Something went wrong getting your number.' });
    expect(JSON.stringify(res.json)).not.toContain('States.Runtime'); // raw error names stay out of owner-facing data
  });

  it('asks for a card when the card check is what stopped the run', async () => {
    const h = new History().enter('CheckPaymentMethod').fail('CheckPaymentMethod', 'NeedsPaymentMethod');
    const { res } = await statusFor(h, { status: 'FAILED' });
    expect(res.json.state).toBe('needs_card');
    expect(res.json.waitingOn).toEqual(['card']);
    expect(stepOf(res.json, 'payment')).toMatchObject({ state: 'waiting_owner', messageForOwner: 'I need a card on file before I can get your number.' });
    expect(lines(res.json)[0]).toBe('I need a card on file before I can get your number.');
  });

  it('a timed-out owner step is reported as that step failing', async () => {
    const base = () => new History().enter('CheckPaymentMethod').exit('CheckPaymentMethod').enter('Build', 'ParallelStateEntered');
    const withEvent = await statusFor(base().enter('AwaitProfileComplete').timeout('AwaitProfileComplete'), { status: 'FAILED' });
    expect(withEvent.res.json.state).toBe('failed');
    expect(stepOf(withEvent.res.json, 'profile')?.state).toBe('failed');
    // no failure event to point at (the whole run timed out): whatever was in flight did not finish
    const whole = await statusFor(base().enter('AwaitProfileComplete'), { status: 'TIMED_OUT' });
    expect(whole.res.json.state).toBe('failed');
    expect(stepOf(whole.res.json, 'profile')?.state).toBe('failed');
  });

  it('degrades to the execution status when the history cannot be read', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    t.wf.failHistory = true;
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const running = await t.status();
    expect(running.status).toBe(200);
    expect(running.json.state).toBe('running');
    expect(lines(running.json)).toEqual(['Setup is running. Give it a minute.']);
    t.wf.executions.get(ID)!.status = 'FAILED';
    expect((await t.status()).json.state).toBe('failed');
    t.wf.executions.get(ID)!.status = 'SUCCEEDED';
    t.wf.executions.get(ID)!.output = JSON.stringify({ ...WITH_NUMBER });
    const done = await t.status();
    expect(done.json.state).toBe('done');
    expect(done.json.numberDisplay).toBe('(469) 555-0142');
    log.mockRestore();
  });

  it('reports the latest attempt after a restart', async () => {
    const t = await withBasics(setup());
    await t.start({ body: {} });
    t.wf.executions.get(ID)!.status = 'FAILED';
    await t.start({ body: {} });
    t.wf.histories.set(ID, new History().enter('CheckPaymentMethod').fail('CheckPaymentMethod', 'NeedsPaymentMethod').events);
    t.wf.histories.set(`${ID}.2`, new History().enter('CheckPaymentMethod').exit('CheckPaymentMethod').enter('Build', 'ParallelStateEntered').enter('SearchNumber').events);
    const r = await t.status();
    expect(r.json.state).toBe('running');
    expect(stepOf(r.json, 'number')?.messageForOwner).toBe('Looking for a local number near you.');
  });

  it('says waitlisted for a waitlisted onboarding', async () => {
    const t = await withBasics(setup());
    await t.waitlistCall({ body: { reason: 'healthcare' } });
    const r = await t.status();
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('waitlisted');
  });

  it('answers 404 for an unknown onboarding and does not crash when the execution has expired', async () => {
    expect((await setup({}).status()).status).toBe(404);
    const t = await withBasics(setup());
    await t.start({ body: {} });
    t.wf.executions.delete(ID); // retention expired or deleted: do not crash, do not claim progress
    const r = await t.status();
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('not_started');
  });

  it('every line the owner can read passes conversation-style (chat), with no issues at all', async () => {
    const all = new Set<string>();
    const collect = (json: Record<string, any>) => (json.steps as Array<Record<string, any>>).forEach((s) => { if (s.messageForOwner) all.add(s.messageForOwner); });
    const build = () => new History().enter('CheckPaymentMethod').exit('CheckPaymentMethod').enter('Build', 'ParallelStateEntered');
    const scenarios: Array<[History, ExecutionInfo['status'], unknown?]> = [
      [new History().enter('CheckPaymentMethod'), 'RUNNING'],
      [new History().enter('CheckPaymentMethod').fail('CheckPaymentMethod', 'NeedsPaymentMethod'), 'FAILED'],
      [new History().enter('CheckPaymentMethod').fail('CheckPaymentMethod', 'Boom'), 'FAILED'],
      [build().enter('SearchNumber'), 'RUNNING'],
      [build().enter('SearchNumber').fail('SearchNumber', 'NoNumberAvailable'), 'FAILED'],
      [build().enter('SearchNumber').exit('SearchNumber').enter('OrderNumber'), 'RUNNING'],
      [build().enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').exit('OrderNumber').enter('BindEngine'), 'RUNNING'],
      [build().enter('ScrapeKnowledge'), 'RUNNING'],
      [build().enter('ScrapeKnowledge').fail('ScrapeKnowledge', 'Boom'), 'FAILED'],
      [build().enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed'), 'RUNNING'],
      [build().enter('ScrapeKnowledge').exit('ScrapeKnowledge').enter('AwaitFactsConfirmed').exit('AwaitFactsConfirmed'), 'RUNNING'],
      [build().enter('AwaitProfileComplete'), 'RUNNING'],
      [build().enter('AwaitProfileComplete').exit('AwaitProfileComplete'), 'RUNNING'],
      [build().enter('AwaitProfileComplete').fail('AwaitProfileComplete', 'Boom'), 'FAILED'],
      [build().enter('SearchNumber').exit('SearchNumber').enter('OrderNumber').exit('OrderNumber').enter('BindEngine').exit('BindEngine', WITH_NUMBER).enter('RenderAgent'), 'RUNNING'],
      [build().enter('RenderAgent').fail('RenderAgent', 'Boom'), 'FAILED'],
      [build().enter('RenderAgent').exit('RenderAgent').enter('AwaitAgentName'), 'RUNNING'],
      [build().enter('RenderAgent').exit('RenderAgent').enter('AwaitAgentName').exit('AwaitAgentName'), 'RUNNING'],
      [build().enter('SmokeCall'), 'RUNNING'],
      [build().enter('SmokeCall').fail('SmokeCall', 'Boom'), 'FAILED'],
      [build().enter('SmokeCall').exit('SmokeCall').enter('ActivateTenant'), 'RUNNING'],
      [build().enter('ActivateTenant').fail('ActivateTenant', 'Boom'), 'FAILED'],
      [build().enter('ActivateTenant').exit('ActivateTenant'), 'SUCCEEDED', { ...WITH_NUMBER }],
    ];
    for (const [h, status, output] of scenarios) collect((await statusFor(h, { status, output })).res.json);
    // history unreadable: the run's own status still gets a plain line
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const status of ['RUNNING', 'SUCCEEDED', 'FAILED'] as const) {
      const fallback = await withBasics(setup());
      await fallback.start({ body: {} }); fallback.wf.failHistory = true;
      fallback.wf.executions.get(ID)!.status = status;
      (await fallback.status()).json.progress.forEach((l: string) => all.add(l));
    }
    quiet.mockRestore();

    expect(all.size).toBeGreaterThanOrEqual(20);
    for (const line of all) {
      expect(checkReply(line, { channel: 'chat' }), line).toEqual([]);
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/https?:\/\/|[A-Z][a-z]+[A-Z][a-z]+(?:Method|Available|Error)|arn:|\bt_[a-z0-9]{8}/); // no raw identifiers
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. DynamoDB store (command shapes; the table is `t1145`, see contracts/dynamodb/keys.md)
// ---------------------------------------------------------------------------------------------------------------

describe('ddbOnboardingStore', () => {
  function recorder(respond: (type: string, input: any) => any = () => ({})) {
    const sent: Array<{ type: string; input: any }> = [];
    return { sent, send: async (cmd: { constructor: { name: string }; input: any }) => { sent.push({ type: cmd.constructor.name, input: cmd.input }); return respond(cmd.constructor.name, cmd.input); } };
  }

  it('reads STATE and BASICS under ONBOARDING#<id> with strongly consistent reads', async () => {
    const doc = recorder((type, input) => ({ Item: input.Key.SK === 'STATE' ? { PK: input.Key.PK, SK: 'STATE', onboardingId: ID, channel: 'webchat', provisioning: { executionName: ID, attempt: 1, startedAt: 'x' } } : { PK: input.Key.PK, SK: 'BASICS', businessName: 'Kemi Cuts', businessType: 'barber', areaText: 'Frisco', area: {}, updatedAt: 'x' } }));
    const store = ddbOnboardingStore(doc, 't1145');
    expect(await store.getState(ID)).toMatchObject({ onboardingId: ID, channel: 'webchat', provisioning: { attempt: 1 } });
    expect(await store.getBasics(ID)).toMatchObject({ businessName: 'Kemi Cuts' });
    expect(doc.sent.map((s) => [s.type, s.input.TableName, s.input.Key, s.input.ConsistentRead])).toEqual([
      ['GetCommand', 't1145', { PK: `ONBOARDING#${ID}`, SK: 'STATE' }, true],
      ['GetCommand', 't1145', { PK: `ONBOARDING#${ID}`, SK: 'BASICS' }, true],
    ]);
  });

  it('returns undefined when the item is missing', async () => {
    const store = ddbOnboardingStore(recorder(() => ({})), 't1145');
    expect(await store.getState(ID)).toBeUndefined();
    expect(await store.getBasics(ID)).toBeUndefined();
  });

  it('refuses ids that could escape the partition', async () => {
    const store = ddbOnboardingStore(recorder(), 't1145');
    await expect(store.getState('a#b')).rejects.toThrow(/onboardingId/);
  });

  it('putBasics writes the BASICS item next to STATE and never touches STATE', async () => {
    const doc = recorder();
    await ddbOnboardingStore(doc, 't1145').putBasics(ID, { businessName: 'Kemi Cuts', businessType: 'barber', areaText: 'Frisco, TX', area: { state: 'TX' }, updatedAt: 'now' });
    expect(doc.sent).toHaveLength(1);
    expect(doc.sent[0]!.type).toBe('PutCommand');
    expect(doc.sent[0]!.input.Item).toMatchObject({ PK: `ONBOARDING#${ID}`, SK: 'BASICS', onboardingId: ID, businessName: 'Kemi Cuts' });
    expect(doc.sent[0]!.input.ConditionExpression).toBeUndefined();
  });

  it('ensureTenantId is first-writer-wins and only on an existing onboarding', async () => {
    const doc = recorder(() => ({ Attributes: { tenantId: TENANT } }));
    const id = await ddbOnboardingStore(doc, 't1145').ensureTenantId(ID, 't_newcandidate0000000');
    expect(id).toBe(TENANT);
    const input = doc.sent[0]!.input;
    expect(doc.sent[0]!.type).toBe('UpdateCommand');
    expect(input.Key).toEqual({ PK: `ONBOARDING#${ID}`, SK: 'STATE' });
    expect(input.UpdateExpression).toContain('if_not_exists(tenantId');
    expect(input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(input.ReturnValues).toBe('ALL_NEW');
  });

  it('markWaitlisted flags STATE first, then writes the WAITLIST item once', async () => {
    const doc = recorder();
    await ddbOnboardingStore(doc, 't1145').markWaitlisted(ID, { reason: 'healthcare', at: 'now' });
    expect(doc.sent.map((s) => s.type)).toEqual(['UpdateCommand', 'PutCommand']);
    expect(doc.sent[0]!.input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(doc.sent[1]!.input.Item).toMatchObject({ PK: `ONBOARDING#${ID}`, SK: 'WAITLIST', reason: 'healthcare' });
    expect(doc.sent[1]!.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('markWaitlisted treats an existing WAITLIST item as success', async () => {
    const doc = recorder((type) => { if (type === 'PutCommand') throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }); return {}; });
    await expect(ddbOnboardingStore(doc, 't1145').markWaitlisted(ID, { reason: 'healthcare', at: 'now' })).resolves.toBeUndefined();
  });

  it('recordProvisioning never moves the attempt backwards', async () => {
    const doc = recorder();
    await ddbOnboardingStore(doc, 't1145').recordProvisioning(ID, { executionName: `${ID}.2`, attempt: 2, startedAt: 'now' });
    const input = doc.sent[0]!.input;
    expect(input.Key).toEqual({ PK: `ONBOARDING#${ID}`, SK: 'STATE' });
    expect(input.ConditionExpression).toContain('attribute_exists(PK)');
    expect(input.ConditionExpression).toContain('provisioning.attempt');
    expect(input.ExpressionAttributeValues[':p']).toEqual({ executionName: `${ID}.2`, attempt: 2, startedAt: 'now' });
  });

  it('recordProvisioning tolerates a concurrent writer that got there with the same or a later attempt', async () => {
    const doc = recorder(() => { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); });
    await expect(ddbOnboardingStore(doc, 't1145').recordProvisioning(ID, { executionName: ID, attempt: 1, startedAt: 'now' })).resolves.toBeUndefined();
  });
});
