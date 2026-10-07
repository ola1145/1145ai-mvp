import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyTenantToken } from '@1145/shared';
import { resolveNumber } from '../src/handlers/internal-resolve-number.js';
import { resolveWidget } from '../src/handlers/internal-resolve-widget.js';
import { CALL_TOKEN_TTL_SECONDS, createResolverDeps, ddbItemReaders, prodResolverDeps, type DocLike, type ResolverPorts } from '../src/lib/resolver-deps.js';
import { handle, HttpError, type HttpEvent } from '../src/lib/http.js';
import { requireTenantContext } from '../src/lib/tenant-auth.js';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { SECRET } from './fakes.js';

// Production wiring (below) takes its tenant-scoped client from ddb-repo.ts (CR T5-2). The stand-ins let a test see whose client
// was asked for and count providers built the old way (a second AssumeRole cache of our own), which must stay at zero.
const ddbRepo = vi.hoisted(() => ({ docFor: undefined as undefined | ((tid: string) => Promise<unknown>), providersBuilt: 0 }));
vi.mock('../src/lib/ddb-repo.js', () => ({
  tenantDocFor: (tid: string) => ddbRepo.docFor!(tid),
  createTenantDocProvider: () => { ddbRepo.providersBuilt++; return (tid: string) => ddbRepo.docFor!(tid); },
}));
vi.mock('../src/deps.js', async () => {
  const { SECRET: secret } = await import('./fakes.js');
  return { prodDeps: async () => ({ tokenSecrets: async () => [secret, 'previous-secret'] }) };
});

type Item = Record<string, unknown>;

const TID_A = 't_tenanta01';
const TID_B = 't_tenantb02';
const DIALED = '+12145550100';
const CALLER = '+12145550123';
const WIDGET = 'wk_8fJ2kQ9xLm4TzR7a';
const ROOM = 'chat-t_tenanta01-5b0c9e1a-7d2f-4c61-9a0e-3f4b8c2d1e77';
const DISCLOSURE = "Hi, this is Ava at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?";

const profile = (tid: string, over: Item = {}): Item => ({
  PK: `TENANT#${tid}`, SK: 'PROFILE', name: 'Kemi Cuts', timezone: 'America/Chicago', state: 'active',
  agentName: 'Ava', voiceId: 'voice_warm_f1', language: 'en-US', templateVersion: 'receptionist@1.0.0',
  renderedInstructions: '<rendered instructions for Kemi Cuts>', renderedDisclosureLine: DISCLOSURE, ...over,
});

/** In-memory stand-in for the three reads the resolver does. Counts every read so tests can assert round trips. */
class FakeStore implements ResolverPorts {
  numbers = new Map<string, Item>([[DIALED, { PK: `NUMBER#${DIALED}`, SK: 'ROUTE', tid: TID_A, engine: 'livekit-telnyx', state: 'active' }]]);
  widgets = new Map<string, Item>([[WIDGET, { PK: `WIDGET#${WIDGET}`, SK: 'ROUTE', tid: TID_A, enabled: true }]]);
  profiles = new Map<string, Item>([[TID_A, profile(TID_A)], [TID_B, profile(TID_B, { name: 'Other Shop', agentName: 'Max' })]]);
  reads = { number: 0, widget: 0, profile: 0 };
  profileFails = false;
  gate?: Promise<void>;
  clock = 1_000_000;
  now = () => this.clock;
  async numberRoute(e164: string) { this.reads.number++; return this.numbers.get(e164); }
  async widgetRoute(key: string) { this.reads.widget++; return this.widgets.get(key); }
  async profile(tid: string) {
    this.reads.profile++;
    if (this.gate) await this.gate;
    if (this.profileFails) throw new Error('ddb down');
    return this.profiles.get(tid);
  }
  async signingSecret() { return SECRET; }
}

const ev = (body: unknown): HttpEvent => ({ headers: {}, body: JSON.stringify(body), requestContext: { requestId: 'req-1' } });
const numberReq = (over: Item = {}) => ev({ dialed: DIALED, caller: CALLER, callId: 'v3:call-7f3a', ...over });
const widgetReq = (over: Item = {}) => ev({ widgetKey: WIDGET, callId: ROOM, ...over });
const setup = () => { const store = new FakeStore(); return { store, deps: createResolverDeps(store) }; };
const claims = (token: string) => verifyTenantToken(token, [SECRET]);

// The not-ready path logs one structured warning; keep it out of the test output, and look at what it says.
let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warnings.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('resolveNumber: the dialed number decides the tenant', () => {
  it('returns runtime config from PROFILE.rendered* and a call-scoped customer-agent token', async () => {
    const { deps } = setup();
    const res = await resolveNumber(numberReq(), deps);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      tenantId: TID_A, state: 'active',
      agent: {
        agentName: 'Ava', businessName: 'Kemi Cuts', timezone: 'America/Chicago', disclosureLine: DISCLOSURE,
        instructions: '<rendered instructions for Kemi Cuts>', voiceId: 'voice_warm_f1', language: 'en-US', templateVersion: 'receptionist@1.0.0',
      },
    });
    expect(claims(body.token)).toMatchObject({ tid: TID_A, prn: 'customer-agent', cid: 'v3:call-7f3a', clr: CALLER, ch: 'voice', aud: 'tool-api' });
  });

  it('mints a token the rest of the tool API accepts, bound to the tenant and call', async () => {
    const { deps } = setup();
    const { token } = JSON.parse((await resolveNumber(numberReq(), deps)).body);
    const ctx = await requireTenantContext(
      { headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 'r' } }, 'createBooking',
      { tokenSecrets: async () => [SECRET], engineSecret: async () => undefined, tenantForEngineAgent: async () => undefined },
    );
    expect(ctx).toMatchObject({ tenantId: TID_A, principal: 'customer-agent', channel: 'voice', callId: 'v3:call-7f3a', callerE164: CALLER });
  });

  it('lets the token live about as long as the longest call, not an hour (SEC-08)', async () => {
    const { deps } = setup();
    const { token } = JSON.parse((await resolveNumber(numberReq(), deps)).body);
    const c = claims(token);
    expect(c.exp - c.iat).toBe(CALL_TOKEN_TTL_SECONDS);
    expect(CALL_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(15 * 60 + 60); // a call is capped at 15 minutes; leave a margin
    expect(CALL_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(20 * 60);
  });

  it('carries the route state in the token, so the tool API can refuse booking tools for a suspended or over-cap tenant (SEC-08)', async () => {
    const { deps, store } = setup();
    const st = async () => (claims(JSON.parse((await resolveNumber(numberReq(), deps)).body).token) as { st?: string }).st;
    expect(await st()).toBe('active');
    store.numbers.set(DIALED, { tid: TID_A, state: 'suspended' });
    expect(await st()).toBe('suspended');
    store.numbers.set(DIALED, { tid: TID_A, state: 'over_cap' });
    expect(await st()).toBe('over_cap');
    store.numbers.set(DIALED, { tid: TID_A, state: 'banana' }); // unrecognised: fail closed, same as the response
    expect(await st()).toBe('suspended');
    store.numbers.set(DIALED, { tid: TID_A, state: 'active' });
    store.profiles.set(TID_A, profile(TID_A, { state: 'suspended' })); // the stricter of route and profile wins
    store.clock += 61_000; // past the 60 s profile cache
    expect(await st()).toBe('suspended');
  });

  it('puts in the token the same state it tells the worker', async () => {
    const { deps, store } = setup();
    for (const state of ['active', 'over_cap', 'suspended']) {
      store.numbers.set(DIALED, { tid: TID_A, state });
      const body = JSON.parse((await resolveNumber(numberReq(), deps)).body);
      expect((claims(body.token) as { st?: string }).st).toBe(body.state);
    }
  });

  it('answers 404 for a number nobody owns and never reads a profile for it', async () => {
    const { deps, store } = setup();
    await expect(resolveNumber(numberReq({ dialed: '+19995550000' }), deps)).rejects.toMatchObject({ status: 404, code: 'unassigned' });
    expect(store.reads.profile).toBe(0);
  });

  it('reports a suspended tenant as state suspended and still hands the worker a token to take a message', async () => {
    const { deps, store } = setup();
    store.numbers.set(DIALED, { tid: TID_A, engine: 'livekit-telnyx', state: 'suspended' });
    const body = JSON.parse((await resolveNumber(numberReq(), deps)).body);
    expect(body.state).toBe('suspended');
    expect(claims(body.token)).toMatchObject({ tid: TID_A, prn: 'customer-agent' });
  });

  it('passes over_cap through', async () => {
    const { deps, store } = setup();
    store.numbers.set(DIALED, { tid: TID_A, state: 'over_cap' });
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).state).toBe('over_cap');
  });

  it('treats a route state it does not recognise as suspended (fail closed)', async () => {
    const { deps, store } = setup();
    store.numbers.set(DIALED, { tid: TID_A, state: 'banana' });
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).state).toBe('suspended');
  });

  it('also honours a suspension recorded on PROFILE (the stricter of route and profile wins)', async () => {
    const { deps, store } = setup();
    store.profiles.set(TID_A, profile(TID_A, { state: 'suspended' }));
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).state).toBe('suspended');
  });

  it('does not block a call just because PROFILE.state is still provisioning (smoke test before activation)', async () => {
    const { deps, store } = setup();
    store.profiles.set(TID_A, profile(TID_A, { state: 'provisioning' }));
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).state).toBe('active');
  });

  it('ignores a tenant id (or anything else identity-like) in the body', async () => {
    const { deps, store } = setup();
    store.numbers.set('+12145550101', { tid: TID_B, state: 'active' });
    const body = JSON.parse((await resolveNumber(numberReq({ tenantId: TID_B, tid: TID_B, principal: 'owner', prn: 'owner', ch: 'webchat' }), deps)).body);
    expect(body.tenantId).toBe(TID_A);
    expect(body.agent.businessName).toBe('Kemi Cuts');
    expect(claims(body.token)).toMatchObject({ tid: TID_A, prn: 'customer-agent', ch: 'voice' });
  });

  it('puts no caller number in the token when caller ID is withheld or malformed', async () => {
    const { deps } = setup();
    for (const caller of ['anonymous', '', '12145550123', undefined, 42]) {
      const { token } = JSON.parse((await resolveNumber(numberReq({ caller }), deps)).body);
      expect(claims(token).clr).toBeUndefined();
    }
    const noCaller = ev({ dialed: DIALED, callId: 'v3:call-9' });
    expect(claims(JSON.parse((await resolveNumber(noCaller, deps)).body).token).clr).toBeUndefined();
  });

  it('rejects a dialed value that is not E.164 and a missing call id', async () => {
    const { deps, store } = setup();
    await expect(resolveNumber(numberReq({ dialed: '214-555-0100' }), deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolveNumber(numberReq({ dialed: undefined }), deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolveNumber(numberReq({ callId: undefined }), deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolveNumber({ headers: {}, requestContext: { requestId: 'r' } }, deps)).rejects.toMatchObject({ status: 400 });
    expect(store.reads.number).toBe(0);
  });

  it('refuses to mint a token for a route whose tenant id is malformed', async () => {
    const { deps, store } = setup();
    store.numbers.set(DIALED, { tid: 'TENANT#evil', state: 'active' });
    await expect(resolveNumber(numberReq(), deps)).rejects.toThrow();
    store.numbers.set(DIALED, { state: 'active' });
    await expect(resolveNumber(numberReq(), deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('resolveWidget: the widget key decides the tenant', () => {
  it('resolves the key to the same shape as a call, with ch=webchat and no caller number', async () => {
    const { deps } = setup();
    const res = await resolveWidget(widgetReq(), deps);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ tenantId: TID_A, state: 'active', agent: { agentName: 'Ava', businessName: 'Kemi Cuts', disclosureLine: DISCLOSURE } });
    const c = claims(body.token);
    expect(c).toMatchObject({ tid: TID_A, prn: 'customer-agent', cid: ROOM, ch: 'webchat' });
    expect(c.clr).toBeUndefined();
    expect('clr' in c).toBe(false);
  });

  it('mints a token the tool API reads as a webchat customer-agent with no caller number', async () => {
    const { deps } = setup();
    const { token } = JSON.parse((await resolveWidget(widgetReq(), deps)).body);
    const auth = { tokenSecrets: async () => [SECRET], engineSecret: async () => undefined, tenantForEngineAgent: async () => undefined };
    const req = { headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 'r' } };
    const ctx = await requireTenantContext(req, 'takeMessage', auth);
    expect(ctx).toMatchObject({ tenantId: TID_A, principal: 'customer-agent', channel: 'webchat', callId: ROOM });
    expect(ctx.callerE164).toBeUndefined();
    await expect(requireTenantContext(req, 'applyChange', auth)).rejects.toMatchObject({ status: 403 });
  });

  it('gives a chat token the same short lifetime and carries the state (SEC-08)', async () => {
    const { deps, store } = setup();
    const c = claims(JSON.parse((await resolveWidget(widgetReq(), deps)).body).token) as { exp: number; iat: number; st?: string };
    expect(c.exp - c.iat).toBe(CALL_TOKEN_TTL_SECONDS);
    expect(c.st).toBe('active');
    store.widgets.set(WIDGET, { tid: TID_A, enabled: true, state: 'over_cap' });
    expect((claims(JSON.parse((await resolveWidget(widgetReq(), deps)).body).token) as { st?: string }).st).toBe('over_cap');
  });

  it('answers 404 for a disabled widget', async () => {
    const { deps, store } = setup();
    store.widgets.set(WIDGET, { tid: TID_A, enabled: false });
    await expect(resolveWidget(widgetReq(), deps)).rejects.toMatchObject({ status: 404 });
    expect(store.reads.profile).toBe(0);
  });

  it('only an explicit enabled: true opens a widget (same reading as the token endpoint, so the two never disagree)', async () => {
    const { deps, store } = setup();
    for (const enabled of [undefined, null, 'true', 1, 'yes', {}]) {
      store.widgets.set(WIDGET, enabled === undefined ? { tid: TID_A } : { tid: TID_A, enabled });
      await expect(resolveWidget(widgetReq(), deps), String(enabled)).rejects.toMatchObject({ status: 404 });
    }
    expect(store.reads.profile).toBe(0);
  });

  it('answers 404 for an unknown key, and for a key that cannot be one of ours without touching the table', async () => {
    const { deps, store } = setup();
    await expect(resolveWidget(widgetReq({ widgetKey: 'wk_AAAAAAAAAAAAAAAA' }), deps)).rejects.toMatchObject({ status: 404 });
    expect(store.reads.widget).toBe(1);
    for (const bad of ['wk_short', 'WK_8fJ2kQ9xLm4TzR7a', 'wk_8fJ2kQ9x#Lm4TzR7a', `wk_${'a'.repeat(41)}`, `${TID_A}`]) {
      await expect(resolveWidget(widgetReq({ widgetKey: bad }), deps)).rejects.toMatchObject({ status: 404 });
    }
    expect(store.reads.widget).toBe(1);
  });

  it('rejects a missing widget key or room name with 400', async () => {
    const { deps } = setup();
    await expect(resolveWidget(widgetReq({ widgetKey: undefined }), deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolveWidget(widgetReq({ callId: undefined }), deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolveWidget(widgetReq({ callId: 'x'.repeat(129) }), deps)).rejects.toMatchObject({ status: 400 });
  });

  it('ignores a tenant id, caller number or channel sent in the body', async () => {
    const { deps } = setup();
    const body = JSON.parse((await resolveWidget(widgetReq({ tenantId: TID_B, tid: TID_B, caller: CALLER, clr: CALLER, ch: 'voice', prn: 'owner' }), deps)).body);
    expect(body.tenantId).toBe(TID_A);
    const c = claims(body.token);
    expect(c).toMatchObject({ tid: TID_A, prn: 'customer-agent', ch: 'webchat' });
    expect(c.clr).toBeUndefined();
  });

  it('takes the tenant from the key, not from the room name', async () => {
    const { deps } = setup();
    const body = JSON.parse((await resolveWidget(widgetReq({ callId: `chat-${TID_B}-5b0c9e1a-7d2f-4c61-9a0e-3f4b8c2d1e77` }), deps)).body);
    expect(body.tenantId).toBe(TID_A);
  });

  it('reports a suspended tenant (PROFILE.state) and a suspended widget route as suspended', async () => {
    const { deps, store } = setup();
    store.profiles.set(TID_A, profile(TID_A, { state: 'suspended' }));
    expect(JSON.parse((await resolveWidget(widgetReq(), deps)).body).state).toBe('suspended');
    store.profiles.set(TID_A, profile(TID_A));
    store.widgets.set(WIDGET, { tid: TID_A, enabled: true, state: 'over_cap' });
    const fresh = createResolverDeps(store);
    expect(JSON.parse((await resolveWidget(widgetReq(), fresh)).body).state).toBe('over_cap');
  });

  it('treats a widget item with no tenant as unknown', async () => {
    const { deps, store } = setup();
    store.widgets.set(WIDGET, { enabled: true });
    await expect(resolveWidget(widgetReq(), deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('runtime config: PROFILE.rendered*, cached for 60 s', () => {
  it('reads the profile once for repeated resolves inside 60 s, and again after it', async () => {
    const { deps, store } = setup();
    await resolveNumber(numberReq(), deps);
    store.clock += 59_000;
    await resolveWidget(widgetReq(), deps);
    await resolveNumber(numberReq({ callId: 'v3:call-2' }), deps);
    expect(store.reads.profile).toBe(1);
    store.clock += 2_000; // 61 s since the first read
    await resolveNumber(numberReq({ callId: 'v3:call-3' }), deps);
    expect(store.reads.profile).toBe(2);
  });

  it('picks up an edited prompt after the cache expires', async () => {
    const { deps, store } = setup();
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).agent.instructions).toBe('<rendered instructions for Kemi Cuts>');
    store.profiles.set(TID_A, profile(TID_A, { renderedInstructions: '<v2>' }));
    store.clock += 61_000;
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).agent.instructions).toBe('<v2>');
  });

  it('warm path is one route read and no profile read (the whole DynamoDB budget)', async () => {
    const { deps, store } = setup();
    await resolveNumber(numberReq(), deps);
    const before = { ...store.reads };
    await resolveNumber(numberReq({ callId: 'v3:call-2' }), deps);
    expect(store.reads.number - before.number).toBe(1);
    expect(store.reads.profile - before.profile).toBe(0);
  });

  it('shares one load between concurrent first calls', async () => {
    const { deps, store } = setup();
    let open!: () => void;
    store.gate = new Promise<void>((r) => { open = r; });
    const calls = Array.from({ length: 5 }, (_, i) => resolveNumber(numberReq({ callId: `v3:call-${i}` }), deps));
    await new Promise((r) => setTimeout(r, 5));
    open();
    await Promise.all(calls);
    expect(store.reads.profile).toBe(1);
  });

  it('never serves one tenant the other tenant\'s config', async () => {
    const { deps, store } = setup();
    store.numbers.set('+12145550101', { tid: TID_B, state: 'active' });
    const a = JSON.parse((await resolveNumber(numberReq(), deps)).body);
    const b = JSON.parse((await resolveNumber(numberReq({ dialed: '+12145550101' }), deps)).body);
    expect([a.tenantId, a.agent.businessName, a.agent.agentName]).toEqual([TID_A, 'Kemi Cuts', 'Ava']);
    expect([b.tenantId, b.agent.businessName, b.agent.agentName]).toEqual([TID_B, 'Other Shop', 'Max']);
    expect(claims(b.token).tid).toBe(TID_B);
  });

  it('does not cache a failure', async () => {
    const { deps, store } = setup();
    store.profileFails = true;
    await expect(resolveNumber(numberReq(), deps)).rejects.toThrow('ddb down');
    store.profileFails = false;
    expect((await resolveNumber(numberReq(), deps)).statusCode).toBe(200);
    expect(store.reads.profile).toBe(2);
  });

  it('fills language and agent name defaults, and leaves voiceId out when the tenant has none', async () => {
    const { deps, store } = setup();
    const p = profile(TID_A);
    delete p.language; delete p.agentName; delete p.voiceId;
    store.profiles.set(TID_A, p);
    const { agent } = JSON.parse((await resolveNumber(numberReq(), deps)).body);
    expect(agent).toMatchObject({ language: 'en-US', agentName: 'Ava' });
    expect('voiceId' in agent).toBe(false);
  });

  it('accepts businessName as an alias for name', async () => {
    const { deps, store } = setup();
    const p = profile(TID_A, { businessName: 'Kemi Cuts & Co' });
    delete p.name;
    store.profiles.set(TID_A, p);
    expect(JSON.parse((await resolveNumber(numberReq(), deps)).body).agent.businessName).toBe('Kemi Cuts & Co');
  });

  it('answers 503 (not a half-built prompt) when the profile is missing or not rendered yet, and does not cache it', async () => {
    const { deps, store } = setup();
    store.profiles.delete(TID_A);
    await expect(resolveNumber(numberReq(), deps)).rejects.toMatchObject({ status: 503, code: 'not_ready' });
    for (const missing of ['renderedInstructions', 'renderedDisclosureLine', 'templateVersion', 'timezone', 'name']) {
      const p = profile(TID_A);
      delete p[missing];
      store.profiles.set(TID_A, p);
      await expect(resolveNumber(numberReq(), deps)).rejects.toMatchObject({ status: 503, code: 'not_ready' });
    }
    store.profiles.set(TID_A, profile(TID_A, { timezone: 'Mars/Olympus' }));
    await expect(resolveNumber(numberReq(), deps)).rejects.toMatchObject({ status: 503 });
    store.profiles.set(TID_A, profile(TID_A));
    expect((await resolveNumber(numberReq(), deps)).statusCode).toBe(200);
  });

  it('signs with the first (current) secret', async () => {
    const store = new FakeStore();
    store.signingSecret = async () => 'rotated-current';
    const body = JSON.parse((await resolveNumber(numberReq(), createResolverDeps(store))).body);
    expect(verifyTenantToken(body.token, ['rotated-current']).tid).toBe(TID_A);
    expect(() => verifyTenantToken(body.token, [SECRET])).toThrow();
  });
});

describe('ddbItemReaders: which keys are read, and with whose credentials', () => {
  type Sent = { table: string; key: Item; consistent?: boolean; projection?: string };
  /** Resolve `#a0, #a1` aliases back to attribute names, the way DynamoDB would. */
  const attributesRead = (projection: string | undefined, names: Record<string, string> | undefined) =>
    (projection ?? '').split(',').map((a) => a.trim()).filter(Boolean).map((a) => names?.[a] ?? a);
  const lastNames: { current?: Record<string, string> } = {};
  const recorder = (item?: Item) => {
    const sent: Sent[] = [];
    const doc: DocLike = {
      async send(cmd) {
        const i = cmd.input as { TableName: string; Key: Item; ConsistentRead?: boolean; ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> };
        lastNames.current = i.ExpressionAttributeNames;
        sent.push({ table: i.TableName, key: i.Key, consistent: i.ConsistentRead, projection: i.ProjectionExpression });
        return { Item: item };
      },
    };
    return { sent, doc };
  };

  it('reads NUMBER#<e164>/ROUTE and WIDGET#<key>/ROUTE with the execution role, consistently', async () => {
    const route = recorder({ tid: TID_A });
    const readers = ddbItemReaders({ routeDoc: route.doc, tenantDocFor: async () => { throw new Error('no tenant creds for route reads'); }, table: 't1145-test' });
    expect(await readers.numberRoute(DIALED)).toEqual({ tid: TID_A });
    expect(await readers.widgetRoute(WIDGET)).toEqual({ tid: TID_A });
    expect(route.sent).toEqual([
      { table: 't1145-test', key: { PK: `NUMBER#${DIALED}`, SK: 'ROUTE' }, consistent: true, projection: undefined },
      { table: 't1145-test', key: { PK: `WIDGET#${WIDGET}`, SK: 'ROUTE' }, consistent: true, projection: undefined },
    ]);
  });

  it('reads TENANT#<tid>/PROFILE through the ABAC client minted for that tenant only', async () => {
    const asked: string[] = [];
    const tenantA = recorder(profile(TID_A));
    const readers = ddbItemReaders({
      routeDoc: recorder().doc, table: 't1145-test',
      tenantDocFor: async (tid) => { asked.push(tid); return tenantA.doc; },
    });
    expect(await readers.profile(TID_A)).toMatchObject({ name: 'Kemi Cuts' });
    expect(asked).toEqual([TID_A]);
    expect(tenantA.sent).toHaveLength(1);
    expect(tenantA.sent[0]!.key).toEqual({ PK: `TENANT#${TID_A}`, SK: 'PROFILE' });
    // Only what the resolver needs is pulled out of PROFILE (no owner contact details, no engine refs).
    const read = attributesRead(tenantA.sent[0]!.projection, lastNames.current);
    expect(read).toEqual(expect.arrayContaining(['renderedInstructions', 'renderedDisclosureLine', 'templateVersion', 'timezone', 'name', 'state']));
    expect(read.join(' ')).not.toMatch(/engineRef|handoffNumber|email|phone/i);
  });

  it('never builds a key from anything but the validated inputs', async () => {
    const route = recorder();
    const readers = ddbItemReaders({ routeDoc: route.doc, tenantDocFor: async () => route.doc, table: 't' });
    await expect(readers.widgetRoute('wk_x#y')).resolves.toBeUndefined();
    await expect(readers.numberRoute('NUMBER#+1')).resolves.toBeUndefined();
    expect(route.sent).toEqual([]);
  });
});

describe('production wiring', () => {
  it('reads PROFILE through the one tenant client provider ddb-repo exports, not a second AssumeRole cache (CR T5-2)', async () => {
    const asked: string[] = [];
    ddbRepo.docFor = async (tid) => { asked.push(tid); return { send: async () => ({ Item: profile(tid) }) }; };
    ddbRepo.providersBuilt = 0;
    const deps = await prodResolverDeps();
    const runtime = await deps.runtimeConfig(TID_A);
    expect(runtime.agent.businessName).toBe('Kemi Cuts');
    expect(asked).toEqual([TID_A]);
    expect(ddbRepo.providersBuilt).toBe(0);
  });

  it('signs with the current tool API secret, never the previous one', async () => {
    expect(await (await prodResolverDeps()).signingSecret()).toBe(SECRET);
  });
});

describe('end to end through the HTTP wrapper', () => {
  it('maps an unknown number to a 404 with a natural line and an unknown widget the same way', async () => {
    const { deps } = setup();
    const num = await handle((e) => resolveNumber(e, deps))(numberReq({ dialed: '+19995550000' }));
    const wid = await handle((e) => resolveWidget(e, deps))(widgetReq({ widgetKey: 'wk_AAAAAAAAAAAAAAAA' }));
    expect([num.statusCode, wid.statusCode]).toEqual([404, 404]);
    for (const r of [num, wid]) {
      const b = JSON.parse(r.body);
      expect(b.sayToCaller).toBeTruthy();
      expect(JSON.stringify(b)).not.toContain(TID_A);
    }
  });

  it('every line the resolver can hand back passes conversation-style', async () => {
    const { deps, store } = setup();
    const lines: string[] = [];
    const grab = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof HttpError && e.sayToCaller) lines.push(e.sayToCaller); } };
    await grab(resolveNumber(numberReq({ dialed: '+19995550000' }), deps));
    await grab(resolveWidget(widgetReq({ widgetKey: 'wk_AAAAAAAAAAAAAAAA' }), deps));
    store.profiles.delete(TID_A);
    await grab(resolveNumber(numberReq(), deps));
    await grab(resolveWidget(widgetReq(), deps));
    expect(lines.length).toBe(4);
    for (const line of lines) expect(checkReply(line, { channel: 'voice' }), line).toEqual([]);
  });

  it('keeps the token out of every error body', async () => {
    const { deps, store } = setup();
    store.profiles.delete(TID_A);
    const r = await handle((e) => resolveNumber(e, deps))(numberReq());
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toMatch(/eyJ/);
    // The log names the tenant and the reason, but never the token, the caller's number or the prompt.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(TID_A);
    expect(warnings[0]).not.toMatch(/eyJ|\+1214|instructions for/);
  });
});
