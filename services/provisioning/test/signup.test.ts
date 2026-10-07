import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { cognitoCodeExchange, makeHandler as makeCallbackHandler, pageCopy, type GoogleIdentity } from '../src/api/signup-callback.js';
import { createOnboardingReader, createTelegramPoster, makeHandler as makeLinkHandler, serviceTokenAuthorizer } from '../src/api/signup-link.js';
import {
  PENDING_BINDING_TTL_SECONDS,
  SIGNUP_TTL_SECONDS,
  answerPendingBinding,
  createSignupStores,
  isIdentityConfirmed,
  newSignupToken,
  reverseConfirmationMessage,
  type SignupRecord,
} from '../src/lib/signup-token.js';

// ───────────────────────── a DynamoDB double that understands exactly the expressions the store uses ─────────────────────────

type Item = Record<string, unknown>;
interface Ex { names?: Record<string, string>; values?: Record<string, unknown> }

function fakeDoc() {
  const table = new Map<string, Item>();
  const k = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
  const err = (name: string) => Object.assign(new Error(name), { name });
  const real = (n: string, ex: Ex) => ex.names?.[n] ?? n;

  function holds(item: Item | undefined, cond: string | undefined, ex: Ex): boolean {
    if (!cond) return true;
    return cond.split(' AND ').every((raw) => {
      const c = raw.trim();
      let m = /^attribute_not_exists\((\S+)\)$/.exec(c);
      if (m) return !item || item[real(m[1]!, ex)] === undefined;
      m = /^attribute_exists\((\S+)\)$/.exec(c);
      if (m) return !!item && item[real(m[1]!, ex)] !== undefined;
      m = /^(\S+) (=|<>|>) (:\w+)$/.exec(c);
      if (!m) throw new Error(`fake does not understand condition: ${c}`);
      const left = item?.[real(m[1]!, ex)];
      const right = ex.values?.[m[3]!];
      if (m[2] === '=') return left === right;
      if (m[2] === '<>') return left !== right;
      return typeof left === 'number' && typeof right === 'number' && left > right;
    });
  }

  function update(key: { PK: string; SK: string }, expr: string, ex: Ex): { old: Item | undefined; next: Item; touched: string[] } {
    const old = table.get(k(key));
    const next: Item = { ...(old ?? { PK: key.PK, SK: key.SK }) };
    const [setPart = '', removePart] = expr.replace(/^SET /, '').split(' REMOVE ');
    const touched: string[] = [];
    for (const a of setPart.split(', ')) {
      const m = /^(\S+) = (:\w+)$/.exec(a.trim());
      if (!m) throw new Error(`fake does not understand assignment: ${a}`);
      const name = real(m[1]!, ex);
      next[name] = ex.values?.[m[2]!];
      touched.push(name);
    }
    for (const r of removePart ? removePart.split(', ') : []) delete next[real(r.trim(), ex)];
    return { old, next, touched };
  }

  /** Real DynamoDB rejects a request whose placeholders no expression uses, so this double does too. */
  function strict(parts: { expressions: Array<string | undefined>; names?: Record<string, string>; values?: Record<string, unknown> }) {
    const text = parts.expressions.filter(Boolean).join(' ');
    for (const n of Object.keys(parts.names ?? {})) if (!new RegExp(`${n}(?![A-Za-z0-9_])`).test(text)) throw err(`ValidationException: unused ExpressionAttributeNames ${n}`);
    for (const v of Object.keys(parts.values ?? {})) if (!new RegExp(`${v}(?![A-Za-z0-9_])`).test(text)) throw err(`ValidationException: unused ExpressionAttributeValues ${v}`);
  }

  const doc = {
    table,
    log: [] as string[],
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof GetCommand) { doc.log.push('get'); return { Item: table.get(k(cmd.input.Key as never)) }; }
      if (cmd instanceof PutCommand) {
        strict({ expressions: [cmd.input.ConditionExpression], names: cmd.input.ExpressionAttributeNames, values: cmd.input.ExpressionAttributeValues });
        const item = cmd.input.Item as Item;
        if (!holds(table.get(k(item as never)), cmd.input.ConditionExpression, { names: cmd.input.ExpressionAttributeNames, values: cmd.input.ExpressionAttributeValues })) throw err('ConditionalCheckFailedException');
        table.set(k(item as never), item); doc.log.push('put'); return {};
      }
      if (cmd instanceof UpdateCommand) {
        const ex = { names: cmd.input.ExpressionAttributeNames, values: cmd.input.ExpressionAttributeValues };
        strict({ expressions: [cmd.input.UpdateExpression, cmd.input.ConditionExpression], ...ex });
        const key = cmd.input.Key as { PK: string; SK: string };
        if (!holds(table.get(k(key)), cmd.input.ConditionExpression, ex)) throw err('ConditionalCheckFailedException');
        const { old, next, touched } = update(key, cmd.input.UpdateExpression!, ex);
        table.set(k(key), next); doc.log.push('update');
        if (cmd.input.ReturnValues === 'ALL_NEW') return { Attributes: next };
        if (cmd.input.ReturnValues === 'UPDATED_OLD') return { Attributes: Object.fromEntries(touched.filter((t) => old?.[t] !== undefined).map((t) => [t, old![t]])) };
        return {};
      }
      if (cmd instanceof TransactWriteCommand) {
        const items = cmd.input.TransactItems ?? [];
        for (const t of items) {
          if (t.Update) {
            const ex = { names: t.Update.ExpressionAttributeNames, values: t.Update.ExpressionAttributeValues };
            strict({ expressions: [t.Update.UpdateExpression, t.Update.ConditionExpression], ...ex });
            if (!holds(table.get(k(t.Update.Key as never)), t.Update.ConditionExpression, ex)) throw err('TransactionCanceledException');
          } else if (t.Put) {
            const ex = { names: t.Put.ExpressionAttributeNames, values: t.Put.ExpressionAttributeValues };
            if (!holds(table.get(k(t.Put.Item as never)), t.Put.ConditionExpression, ex)) throw err('TransactionCanceledException');
          }
        }
        for (const t of items) {
          if (t.Update) {
            const key = t.Update.Key as { PK: string; SK: string };
            table.set(k(key), update(key, t.Update.UpdateExpression!, { names: t.Update.ExpressionAttributeNames, values: t.Update.ExpressionAttributeValues }).next);
          } else if (t.Put) table.set(k(t.Put.Item as never), t.Put.Item as Item);
        }
        doc.log.push('tx'); return {};
      }
      throw new Error(`unexpected command ${(cmd as { constructor: { name: string } }).constructor.name}`);
    },
  };
  return doc;
}

// ───────────────────────── fixtures ─────────────────────────

const T0 = Date.parse('2026-10-06T12:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LINK_CFG = { domain: 'ai1145-dev.auth.us-east-1.amazoncognito.com', clientId: 'client123', redirectUri: 'https://api.example.invalid/signup/callback' };

const A: GoogleIdentity = { sub: 'sub-a', email: 'owner.jane@gmail.com' };
const B: GoogleIdentity = { sub: 'sub-b', email: 'mallory@gmail.com' };

function world() {
  let nowMs = T0;
  const now = () => new Date(nowMs);
  const doc = fakeDoc();
  doc.table.set('ONBOARDING#onb_1|STATE', { PK: 'ONBOARDING#onb_1', SK: 'STATE', onboardingId: 'onb_1', status: 'started', channel: 'telegram', channelUserId: '777' });
  doc.table.set('ONBOARDING#onb_web|STATE', { PK: 'ONBOARDING#onb_web', SK: 'STATE', onboardingId: 'onb_web', status: 'started', channel: 'webchat', channelUserId: 'cognito-sub-1' });
  const { signups, bindings } = createSignupStores({ doc, tableName: 't1145', now });

  const sent: Array<{ chatId: string; text: string }> = [];
  const telegram = { failNext: 0 };
  const sendTelegram = async (chatId: string, text: string) => {
    if (telegram.failNext > 0) { telegram.failNext--; throw new Error('telegram down'); }
    sent.push({ chatId, text });
  };

  const exchanged: Array<{ code: string; verifier: string | undefined }> = [];
  const codes: Record<string, GoogleIdentity> = { 'code-a': A, 'code-b': B };
  const exchangeCode = async (code: string, verifier: string | undefined) => {
    exchanged.push({ code, verifier });
    const id = codes[code];
    if (!id) throw new Error('invalid_grant');
    return id;
  };

  const linkHandler = makeLinkHandler({
    authorize: serviceTokenAuthorizer(async () => 'svc-secret'),
    onboardings: createOnboardingReader({ doc, tableName: 't1145' }),
    signups, link: LINK_CFG, sendTelegram, now,
  });
  const callbackHandler = makeCallbackHandler({ signups, exchangeCode, sendTelegram, now });

  const requestLink = (over: { id?: string; pathKey?: 'onboardingId' | 'id'; auth?: string | null; body?: unknown } = {}) => {
    const id = over.id ?? 'onb_1';
    return linkHandler({
      rawPath: `/internal/onboarding/${id}/signup-link`,
      pathParameters: { [over.pathKey ?? 'onboardingId']: id },
      headers: over.auth === null ? {} : { authorization: over.auth ?? 'Bearer svc-secret' },
      body: JSON.stringify(over.body ?? {}),
    });
  };
  const callback = (q: Record<string, string>) => callbackHandler({ rawPath: '/signup/callback', queryStringParameters: q });
  const lastToken = (): string => {
    const m = /state=([A-Za-z0-9_-]{43})/.exec([...sent].reverse().find((s) => s.text.includes('state='))?.text ?? '');
    if (!m) throw new Error('no signup link was sent');
    return m[1]!;
  };

  return {
    doc, signups, bindings, sent, telegram, exchanged, requestLink, callback, lastToken,
    advance: (seconds: number) => { nowMs += seconds * 1000; },
    nowSec: () => sec(nowMs),
  };
}

// ───────────────────────── link ─────────────────────────

describe('signup link (POST /internal/onboarding/{id}/signup-link)', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('never puts the token in the response; the link goes out through the Telegram sender to the onboarding chat', async () => {
    const res = await w.requestLink();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sent: true, expiresInMinutes: 15 });

    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.chatId).toBe('777');
    const token = w.lastToken();
    const url = /https:\/\/\S+/.exec(w.sent[0]!.text)![0];
    expect(new URL(url).searchParams.get('state')).toBe(token);

    // Nothing the agent can read carries the token, the link, or the destination.
    const everything = JSON.stringify(res);
    for (const secret of [token, url, 'oauth2', 'state=', 'code_challenge', '777', 'amazoncognito']) expect(everything).not.toContain(secret);
  });

  it('stores only the hash of the token, with a 15 minute expiry, and keeps the PKCE verifier server-side', async () => {
    await w.requestLink();
    const token = w.lastToken();
    const item = w.doc.table.get(`SIGNUP#${sha(token)}|TOKEN`);
    expect(item).toMatchObject({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', consumed: false, exp: w.nowSec() + SIGNUP_TTL_SECONDS });
    expect(item?.ttl).toBeGreaterThan(w.nowSec() + SIGNUP_TTL_SECONDS);
    expect(JSON.stringify([...w.doc.table.values()])).not.toContain(token);

    // The challenge in the link is the S256 of the verifier we kept.
    const url = new URL(/https:\/\/\S+/.exec(w.sent[0]!.text)![0]);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(String(item?.codeVerifier)).digest('base64url'));
    expect(String(item?.codeVerifier)).not.toContain(token);
  });

  it('takes the destination from the onboarding record, never from the body', async () => {
    const res = await w.requestLink({ body: { onboardingId: 'onb_other', tenantId: 't_evil0001', channelUserId: '999', chatId: '999', channel: 'telegram' } });
    expect(res.statusCode).toBe(200);
    expect(w.sent.map((s) => s.chatId)).toEqual(['777']);
    expect(w.doc.table.get(`SIGNUP#${sha(w.lastToken())}|TOKEN`)).toMatchObject({ onboardingId: 'onb_1', channelUserId: '777' });
  });

  it('answers 401 without the service token, and sends and stores nothing', async () => {
    for (const auth of [null, 'Bearer nope', 'Bearer ', 'svc-secret', 'Basic c3ZjLXNlY3JldA==']) {
      const res = await w.requestLink({ auth });
      expect(res.statusCode, String(auth)).toBe(401);
    }
    expect(w.sent).toEqual([]);
    expect([...w.doc.table.keys()].filter((x) => x.startsWith('SIGNUP#'))).toEqual([]);
  });

  it('accepts the {id} path parameter name the API route uses today, and rejects malformed ids', async () => {
    expect((await w.requestLink({ pathKey: 'id' })).statusCode).toBe(200);
    expect((await w.requestLink({ id: 'onb#1' })).statusCode).toBe(400);
  });

  it('404 for an onboarding that does not exist; 409 for web chat owners, who already signed in with Google', async () => {
    const missing = await w.requestLink({ id: 'onb_missing' });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('unknown_onboarding');
    const web = await w.requestLink({ id: 'onb_web' });
    expect(web.statusCode).toBe(409);
    expect(JSON.parse(web.body).code).toBe('link_not_needed');
    expect(w.sent).toEqual([]);
  });

  it('when Telegram will not take the message, says so (502) and still reveals nothing', async () => {
    w.telegram.failNext = 1;
    const res = await w.requestLink();
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('delivery_failed');
    expect(res.body).not.toMatch(/state=|oauth2|https:/);
  });

  it('a newer link replaces the older one, so a forwarded copy of the old link stops working', async () => {
    await w.requestLink();
    const first = w.lastToken();
    await w.requestLink();
    const second = w.lastToken();
    expect(second).not.toBe(first);

    const stale = await w.callback({ code: 'code-b', state: first });
    expect(stale.statusCode).toBe(410);
    expect(stale.body).toContain(pageCopy.replaced);
    expect(w.exchanged).toEqual([]);                      // no Google work for a dead link
    expect(await w.bindings.get('onb_1')).toBeUndefined(); // and no binding of any kind

    expect((await w.callback({ code: 'code-a', state: second })).statusCode).toBe(200);
  });

  it('refuses to send another link once the identity is confirmed', async () => {
    await w.requestLink();
    await w.callback({ code: 'code-a', state: w.lastToken() });
    await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'YES' }, w.bindings, w.nowSec());
    const before = w.sent.length;
    const res = await w.requestLink();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('already_confirmed');
    expect(w.sent).toHaveLength(before);
  });
});

// ───────────────────────── callback ─────────────────────────

describe('signup callback (GET /signup/callback)', () => {
  let w: ReturnType<typeof world>;
  beforeEach(async () => { w = world(); await w.requestLink(); });

  it('consumes once: the first account becomes a pending binding, a second account gets "link already used"', async () => {
    const token = w.lastToken();
    const first = await w.callback({ code: 'code-a', state: token });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(pageCopy.signedIn);

    const second = await w.callback({ code: 'code-b', state: token });
    expect(second.statusCode).toBe(409);
    expect(second.body).toMatch(/already used/i);
    expect(second.body).toContain(pageCopy.used);

    // Account A still holds the binding, and it is still only pending.
    expect(await w.bindings.get('onb_1')).toMatchObject({ status: 'pending', googleSub: A.sub, email: A.email, channel: 'telegram', channelUserId: '777' });
    // A dead link costs no Google round trip, and only the real owner was messaged.
    expect(w.exchanged.map((e) => e.code)).toEqual(['code-a']);
    expect(w.sent.filter((s) => s.text.includes('signed in'))).toHaveLength(1);
  });

  it('the binding stays pending until the owner replies YES in Telegram', async () => {
    const token = w.lastToken();
    await w.callback({ code: 'code-a', state: token });

    // The reverse confirmation reaches the chat that asked for the link, with the address masked.
    const ask = w.sent.at(-1)!;
    expect(ask.chatId).toBe('777');
    expect(ask.text).toBe(reverseConfirmationMessage(A.email));
    expect(ask.text).toContain('o***@gmail.com');
    expect(ask.text).not.toContain('owner.jane');

    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(false);
    expect((await w.bindings.get('onb_1'))?.status).toBe('pending');

    const yes = await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'YES' }, w.bindings, w.nowSec());
    expect(yes).toMatchObject({ handled: true, outcome: 'confirmed' });
    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(true);
    expect(await w.bindings.get('onb_1')).toMatchObject({ status: 'confirmed', googleSub: A.sub, email: A.email });
  });

  it('a link asked for while a sign-in waits for its YES cannot rebind the identity once that YES lands', async () => {
    await w.callback({ code: 'code-a', state: w.lastToken() }); // A signed in and is waiting for the owner's YES
    await w.requestLink();                                      // the owner asks for another link before answering
    const spare = w.lastToken();
    await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'YES' }, w.bindings, w.nowSec());

    const late = await w.callback({ code: 'code-b', state: spare });
    expect(late.statusCode).toBe(409);
    expect(await w.bindings.get('onb_1')).toMatchObject({ status: 'confirmed', googleSub: A.sub, email: A.email });
    expect(w.sent.filter((s) => s.text.includes('signed in'))).toHaveLength(1);
  });

  it('a YES from anyone but the chat that asked for the link confirms nothing', async () => {
    await w.callback({ code: 'code-b', state: w.lastToken() }); // a stranger got there first with a forwarded link
    for (const who of [{ channel: 'telegram', channelUserId: '999' }, { channel: 'webchat', channelUserId: '777' }]) {
      const r = await answerPendingBinding({ onboardingId: 'onb_1', ...who, text: 'YES' }, w.bindings, w.nowSec());
      expect(r).toEqual({ handled: false });
    }
    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(false);
  });

  it('forwarded link: the stranger signs in first, the owner sees the masked stranger and says NO, then gets a fresh working link', async () => {
    const forwarded = w.lastToken();
    await w.callback({ code: 'code-b', state: forwarded });
    expect(w.sent.at(-1)!.text).toContain('m***@gmail.com');

    const no = await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'NO' }, w.bindings, w.nowSec());
    expect(no).toMatchObject({ handled: true, outcome: 'cancelled' });
    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(false);

    // The forwarded link is spent for good.
    expect((await w.callback({ code: 'code-b', state: forwarded })).statusCode).toBe(409);

    // The owner asks again and signs in themself.
    expect((await w.requestLink()).statusCode).toBe(200);
    expect((await w.callback({ code: 'code-a', state: w.lastToken() })).statusCode).toBe(200);
    await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'yes' }, w.bindings, w.nowSec());
    expect(await w.bindings.get('onb_1')).toMatchObject({ status: 'confirmed', googleSub: A.sub });
  });

  it('a YES that comes after the window confirms nothing', async () => {
    await w.callback({ code: 'code-a', state: w.lastToken() });
    w.advance(PENDING_BINDING_TTL_SECONDS + 1);
    const r = await answerPendingBinding({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', text: 'YES' }, w.bindings, w.nowSec());
    expect(r).toMatchObject({ handled: true, outcome: 'expired' });
    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(false);
  });

  it('two accounts racing for one link: exactly one wins, the other is told it was already used', async () => {
    const token = w.lastToken();
    const [x, y] = await Promise.all([w.callback({ code: 'code-a', state: token }), w.callback({ code: 'code-b', state: token })]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.body).toContain(pageCopy.used);
    const b = await w.bindings.get('onb_1');
    expect(b?.status).toBe('pending');
    expect(w.sent.filter((s) => s.text.includes('signed in'))).toHaveLength(1);
    expect(w.sent.at(-1)!.text).toContain(b!.email === A.email ? 'o***@' : 'm***@');
  });

  it('leaves the link alone when Google sign-in did not finish, so the owner can just tap it again', async () => {
    const token = w.lastToken();
    const denied = await w.callback({ error: 'access_denied', error_description: '<script>alert(1)</script>', state: token });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain(pageCopy.signInFailed);
    expect(denied.body).not.toContain('<script>');

    const badCode = await w.callback({ code: 'code-wrong', state: token });
    expect(badCode.statusCode).toBe(400);
    expect(await w.bindings.get('onb_1')).toBeUndefined();

    expect((await w.callback({ code: 'code-a', state: token })).statusCode).toBe(200);
  });

  it('hands the stored PKCE verifier to the code exchange, never one from the request', async () => {
    const token = w.lastToken();
    await w.callback({ code: 'code-a', state: token, code_verifier: 'attacker-chosen', onboardingId: 'onb_other' });
    const stored = w.doc.table.get(`SIGNUP#${sha(token)}|TOKEN`)?.codeVerifier;
    expect(w.exchanged).toEqual([{ code: 'code-a', verifier: stored }]);
    expect(await w.bindings.get('onb_other')).toBeUndefined();
    expect((await w.bindings.get('onb_1'))?.googleSub).toBe(A.sub);
  });

  it('a link older than 15 minutes says it timed out, and does no Google work', async () => {
    const token = w.lastToken();
    w.advance(SIGNUP_TTL_SECONDS + 1);
    const res = await w.callback({ code: 'code-a', state: token });
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain(pageCopy.expired);
    expect(w.exchanged).toEqual([]);
    expect(await w.bindings.get('onb_1')).toBeUndefined();
  });

  it('unknown, missing or malformed state is a plain 400 with no lookups beyond the hash', async () => {
    const before = w.doc.log.length;
    for (const state of [undefined, '', 'short', 'x'.repeat(43) + '!', 'x'.repeat(44)]) {
      const res = await w.callback(state === undefined ? { code: 'code-a' } : { code: 'code-a', state });
      expect(res.statusCode, String(state)).toBe(400);
      expect(res.body).toContain(pageCopy.badLink);
    }
    expect(w.doc.log.length).toBe(before);
    const unknown = await w.callback({ code: 'code-a', state: newSignupToken().token });
    expect(unknown.statusCode).toBe(400);
    expect(w.exchanged).toEqual([]);
  });

  it('when Telegram is down at confirmation time, the owner is told to ask for a fresh link, and that works', async () => {
    const token = w.lastToken();
    w.telegram.failNext = 1;
    const res = await w.callback({ code: 'code-a', state: token });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain(pageCopy.telegramFailed);
    expect(await isIdentityConfirmed(w.bindings, 'onb_1')).toBe(false);

    expect((await w.requestLink()).statusCode).toBe(200);
    expect((await w.callback({ code: 'code-a', state: w.lastToken() })).statusCode).toBe(200);
    expect(w.sent.at(-1)!.text).toBe(reverseConfirmationMessage(A.email));
  });

  it('pages never echo the token or the code, and tell browsers not to cache or leak a referrer', async () => {
    const token = w.lastToken();
    const results = [
      await w.callback({ code: 'code-a', state: token }),
      await w.callback({ code: 'code-b', state: token }),
      await w.callback({ code: 'code-secret', state: 'x'.repeat(43) }),
    ];
    for (const r of results) {
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.body).not.toContain(token);
      expect(r.body).not.toContain('code-a');
      expect(r.body).not.toContain('code-secret');
      expect(r.body).not.toContain(A.email);
    }
  });
});

describe('what the owner sees in the browser sounds like a person', () => {
  for (const [name, text] of Object.entries(pageCopy)) {
    it(`${name} passes the conversation-style checker with no errors or warnings`, () => {
      expect(checkReply(text, { channel: 'chat' })).toEqual([]);
    });
  }
});

// ───────────────────────── store (DynamoDB) ─────────────────────────

describe('signup store', () => {
  const record = (over: Partial<SignupRecord> = {}): SignupRecord => ({ onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777', exp: sec(T0) + SIGNUP_TTL_SECONDS, codeVerifier: 'v'.repeat(43), ...over });
  const claimFor = (rec: SignupRecord, id: GoogleIdentity) => ({ record: rec, googleSub: id.sub, email: id.email });
  const NOW = sec(T0);
  let doc: ReturnType<typeof fakeDoc>;
  let store: ReturnType<typeof createSignupStores>;
  beforeEach(() => {
    doc = fakeDoc();
    store = createSignupStores({ doc, tableName: 't1145', now: () => new Date(T0) });
  });

  it('consume without a claim burns the token once, and only while it is unexpired', async () => {
    const { hash } = newSignupToken();
    await store.signups.issue(hash, record(), NOW);
    expect(await store.signups.consume(hash, NOW)).toMatchObject({ onboardingId: 'onb_1', channelUserId: '777' });
    expect(await store.signups.consume(hash, NOW)).toBeUndefined();

    const late = newSignupToken();
    await store.signups.issue(late.hash, record(), NOW);
    expect(await store.signups.consume(late.hash, NOW + SIGNUP_TTL_SECONDS + 1)).toBeUndefined();
    expect(await store.signups.consume(newSignupToken().hash, NOW)).toBeUndefined();
  });

  it('consume with a claim burns the token and writes the pending binding in one step; a second claim changes nothing', async () => {
    const { hash } = newSignupToken();
    const rec = record();
    await store.signups.issue(hash, rec, NOW);
    expect(await store.signups.consume(hash, NOW, claimFor(rec, A))).toMatchObject({ onboardingId: 'onb_1' });
    expect(await store.bindings.get('onb_1')).toMatchObject({ status: 'pending', googleSub: 'sub-a', email: A.email, pendingUntil: NOW + PENDING_BINDING_TTL_SECONDS });

    expect(await store.signups.consume(hash, NOW, claimFor(rec, B))).toBeUndefined();
    expect(await store.bindings.get('onb_1')).toMatchObject({ googleSub: 'sub-a' });
    expect(await store.signups.peek(hash)).toMatchObject({ consumed: true });
  });

  it('a token that is no longer the live link cannot claim, and is left unconsumed', async () => {
    const one = newSignupToken(); const two = newSignupToken();
    const rec = record();
    await store.signups.issue(one.hash, rec, NOW);
    await store.signups.issue(two.hash, rec, NOW);
    expect(await store.signups.peek(one.hash)).toMatchObject({ consumed: true, revoked: true });
    expect(await store.signups.peek(two.hash)).toMatchObject({ consumed: false });

    // Even if the revoke had been lost, the binding only accepts the live link.
    doc.table.set(`SIGNUP#${one.hash}|TOKEN`, { ...doc.table.get(`SIGNUP#${one.hash}|TOKEN`)!, consumed: false, revoked: undefined });
    expect(await store.signups.consume(one.hash, NOW, claimFor(rec, B))).toBeUndefined();
    expect(await store.bindings.get('onb_1')).toBeUndefined();
  });

  it('peek reports what the link is without changing it', async () => {
    const { hash } = newSignupToken();
    await store.signups.issue(hash, record(), NOW);
    const view = await store.signups.peek(hash);
    expect(view).toMatchObject({ consumed: false, record: { onboardingId: 'onb_1', exp: NOW + SIGNUP_TTL_SECONDS, codeVerifier: 'v'.repeat(43) } });
    expect(await store.signups.peek(hash)).toEqual(view);
    expect(await store.signups.peek(newSignupToken().hash)).toBeUndefined();
  });

  it('settle confirms or cancels only for the bound identity, only while pending, only inside the window', async () => {
    const claim = async () => {
      const { hash } = newSignupToken();
      const rec = record();
      await store.signups.issue(hash, rec, NOW);
      await store.signups.consume(hash, NOW, claimFor(rec, A));
    };
    const owner = { channel: 'telegram', channelUserId: '777' };

    await claim();
    expect(await store.bindings.settle('onb_1', 'confirmed', { channel: 'telegram', channelUserId: '999' }, NOW)).toBe(false);
    expect(await store.bindings.settle('onb_1', 'confirmed', { channel: 'webchat', channelUserId: '777' }, NOW)).toBe(false);
    expect(await store.bindings.settle('onb_1', 'confirmed', owner, NOW + PENDING_BINDING_TTL_SECONDS + 1)).toBe(false);
    expect((await store.bindings.get('onb_1'))?.status).toBe('pending');

    expect(await store.bindings.settle('onb_1', 'confirmed', owner, NOW + 5)).toBe(true);
    expect(await store.bindings.get('onb_1')).toMatchObject({ status: 'confirmed', confirmedAt: expect.any(String) });
    // Settled once. A late NO cannot undo a confirmed identity.
    expect(await store.bindings.settle('onb_1', 'cancelled', owner, NOW + 6)).toBe(false);
    expect(await store.bindings.settle('onb_missing', 'confirmed', owner, NOW)).toBe(false);
  });

  it('after a NO the identity can try again; after a YES it cannot be re-linked by a new link', async () => {
    const owner = { channel: 'telegram', channelUserId: '777' };
    const first = newSignupToken(); const rec = record();
    await store.signups.issue(first.hash, rec, NOW);
    await store.signups.consume(first.hash, NOW, claimFor(rec, B));
    await store.bindings.settle('onb_1', 'cancelled', owner, NOW);
    expect((await store.bindings.get('onb_1'))?.status).toBe('cancelled');

    const second = newSignupToken();
    expect(await store.signups.issue(second.hash, rec, NOW)).toBe('issued');
    expect(await store.signups.consume(second.hash, NOW, claimFor(rec, A))).toBeDefined();
    await store.bindings.settle('onb_1', 'confirmed', owner, NOW);

    expect(await store.signups.issue(newSignupToken().hash, rec, NOW)).toBe('already_confirmed');
  });

  it('refuses ids that could escape their key segment', async () => {
    await expect(store.bindings.get('onb#1')).rejects.toThrow();
    await expect(store.signups.peek('abc#def')).rejects.toThrow();
  });
});

// ───────────────────────── adapters: service auth, onboarding reader, Telegram, Cognito ─────────────────────────

describe('serviceTokenAuthorizer', () => {
  const auth = serviceTokenAuthorizer(async () => 'svc-secret');
  it('accepts exactly the service token as a bearer credential', async () => {
    expect(await auth('Bearer svc-secret', 'onb_1')).toBe(true);
    expect(await auth('bearer svc-secret', 'onb_1')).toBe(true);
    for (const h of [undefined, '', 'Bearer', 'Bearer ', 'Bearer svc-secre', 'Bearer svc-secret2', 'svc-secret', 'Bearer  svc-secret x']) expect(await auth(h, 'onb_1'), String(h)).toBe(false);
  });
  it('fails closed when no secret is configured', async () => {
    expect(await serviceTokenAuthorizer(async () => undefined)('Bearer ', 'onb_1')).toBe(false);
    expect(await serviceTokenAuthorizer(async () => '')('Bearer ', 'onb_1')).toBe(false);
  });
});

describe('createOnboardingReader', () => {
  it('reads the channel identity the router stored, and nothing else', async () => {
    const doc = fakeDoc();
    doc.table.set('ONBOARDING#onb_1|STATE', { PK: 'ONBOARDING#onb_1', SK: 'STATE', channel: 'telegram', channelUserId: '777', displayName: 'Jane', referrerTid: 't_x' });
    const reader = createOnboardingReader({ doc, tableName: 't1145' });
    expect(await reader.get('onb_1')).toEqual({ channel: 'telegram', channelUserId: '777' });
    expect(await reader.get('onb_2')).toBeUndefined();
  });
});

describe('createTelegramPoster', () => {
  const ok = () => new Response('{"ok":true}', { status: 200 });
  const make = (responses: Array<() => Response>) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sleeps: number[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return (responses[Math.min(i++, responses.length - 1)] ?? ok)();
    }) as unknown as typeof fetch;
    return { calls, sleeps, send: createTelegramPoster({ token: async () => 'BOT:SECRET', fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, maxAttempts: 3 }) };
  };

  it('posts to the bot API with link previews off, so the link is not fetched or cached by anyone', async () => {
    const t = make([ok]);
    await t.send('777', 'hello');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('https://api.telegram.org/botBOT:SECRET/sendMessage');
    expect(t.calls[0]!.body).toMatchObject({ chat_id: '777', text: 'hello', link_preview_options: { is_disabled: true } });
  });

  it('retries 429 (honoring retry_after) and 5xx, but never other 4xx, and never leaks the bot token in an error', async () => {
    const limited = make([() => new Response('{"parameters":{"retry_after":2}}', { status: 429 }), ok]);
    await limited.send('777', 'hi');
    expect(limited.calls).toHaveLength(2);
    expect(limited.sleeps).toEqual([2000]);

    const flaky = make([() => new Response('', { status: 502 }), ok]);
    await flaky.send('777', 'hi');
    expect(flaky.calls).toHaveLength(2);

    const rejected = make([() => new Response('{"ok":false}', { status: 400 })]);
    const e = await rejected.send('777', 'hi').catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(rejected.calls).toHaveLength(1);
    expect(String((e as Error).message)).not.toContain('BOT:SECRET');

    const down = make([() => new Response('', { status: 503 })]);
    await expect(down.send('777', 'hi')).rejects.toThrow();
    expect(down.calls).toHaveLength(3);
  });
});

describe('cognitoCodeExchange', () => {
  const cfg = { domain: LINK_CFG.domain, clientId: LINK_CFG.clientId, redirectUri: LINK_CFG.redirectUri };
  const NOW = new Date(T0);
  const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const good = { sub: 'sub-a', email: 'owner.jane@gmail.com', email_verified: true, aud: 'client123', exp: sec(T0) + 3600, token_use: 'id' };
  const exchangeWith = (res: { status?: number; body: unknown }, capture: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = []) =>
    cognitoCodeExchange({
      ...cfg, now: () => NOW,
      fetchImpl: (async (url: string, init: never) => { capture.push({ url, init }); return new Response(JSON.stringify(res.body), { status: res.status ?? 200 }); }) as unknown as typeof fetch,
    });

  it('trades the code for the verified Google identity, sending the PKCE verifier over a form post', async () => {
    const seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const id = await exchangeWith({ body: { id_token: jwt(good) } }, seen)('the-code', 'the-verifier');
    expect(id).toEqual({ sub: 'sub-a', email: 'owner.jane@gmail.com' });
    expect(seen[0]!.url).toBe(`https://${cfg.domain}/oauth2/token`);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(seen[0]!.init.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', client_id: 'client123', code: 'the-code', redirect_uri: cfg.redirectUri, code_verifier: 'the-verifier' });
  });

  it('rejects anything that is not a clean, fresh id token for this client', async () => {
    const bad: Array<[string, { status?: number; body: unknown }]> = [
      ['http error', { status: 400, body: { error: 'invalid_grant' } }],
      ['no id token', { body: { access_token: 'x' } }],
      ['garbage token', { body: { id_token: 'nope' } }],
      ['wrong audience', { body: { id_token: jwt({ ...good, aud: 'someone-else' }) } }],
      ['expired', { body: { id_token: jwt({ ...good, exp: sec(T0) - 1 }) } }],
      ['unverified email', { body: { id_token: jwt({ ...good, email_verified: false }) } }],
      ['no email', { body: { id_token: jwt({ ...good, email: undefined }) } }],
      ['no subject', { body: { id_token: jwt({ ...good, sub: undefined }) } }],
    ];
    for (const [name, res] of bad) await expect(exchangeWith(res)('c', 'v'), name).rejects.toThrow();
  });
});
