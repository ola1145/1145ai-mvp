import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { parseTelegramStart, parseWhatsAppReferral, verifyMetaSignature } from '../src/lib/verify.js';
import { whatsappWebhook } from '../src/whatsapp-webhook.js';
import { routeInbound, type RouterDeps, type AgentPayload } from '../src/router.js';
import { processBatch } from '../src/router-worker.js';
import type { InboundMessage } from '../src/lib/types.js';
import { verifyTenantToken } from '@1145/shared';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { APPLIED_LINE, CODE_NOT_FOUND_LINE, HOLDING_LINES, PAUSED_LINE, RATE_LIMIT_LINES, SNAG_LINES, STEP_UP_LINE } from '../src/lib/copy.js';
import { runtimeSessionId } from '../src/lib/session.js';
import { createAgentInvoker } from '../src/lib/agentcore.js';
import { createStore } from '../src/lib/store.js';
import { createSender } from '../src/lib/senders.js';
import { createOwnerChatPublisher } from '../src/lib/appsync-events.js';
import { createTelegramSender } from '../src/telegram-send.js';
import { createBindingAnswerer } from '../src/lib/binding.js';
import * as shared from '@1145/shared';

// Spy on safeEqual (keeping its real behavior) so a test can prove a secret is compared with it and not with ===.
vi.mock('@1145/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@1145/shared')>();
  return { ...original, safeEqual: vi.fn(original.safeEqual) };
});

const APP_SECRET = 'app-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

describe('webhook verification', () => {
  it('accepts a valid Meta signature and rejects a tampered body', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature(body, sign(body), APP_SECRET)).toBe(true);
    expect(verifyMetaSignature('{"a":2}', sign(body), APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false);
  });
  it('parses referral codes', () => {
    expect(parseTelegramStart('/start AB12_cd')).toBe('AB12_cd');
    expect(parseTelegramStart('/start ../../etc')).toBeUndefined();
    expect(parseWhatsAppReferral('Hi 1145! ref:XY9Z12')).toBe('XY9Z12');
  });
});

describe('whatsappWebhook (dormant, Phase 2)', () => {
  const deps = (sink: InboundMessage[]) => ({
    appSecret: async () => APP_SECRET, verifyToken: async () => 'vt',
    enqueue: async (m: InboundMessage) => { sink.push(m); }, now: () => new Date('2026-10-02T12:00:00Z'),
  });

  it('answers the GET verification challenge', async () => {
    const r = await whatsappWebhook({ requestContext: { http: { method: 'GET' } }, headers: {}, queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '42' } }, deps([]));
    expect(r).toEqual({ statusCode: 200, body: '42' });
  });

  it('enqueues text messages after verifying the signature', async () => {
    const sink: InboundMessage[] = [];
    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '15550001', profile: { name: 'Kemi' } }], messages: [{ from: '15550001', id: 'wamid.1', type: 'text', text: { body: 'hello ref:FRIEND1' } }] } }] }] });
    const r = await whatsappWebhook({ requestContext: { http: { method: 'POST' } }, headers: { 'x-hub-signature-256': sign(body) }, body }, deps(sink));
    expect(r.statusCode).toBe(200);
    expect(sink[0]).toMatchObject({ channelUserId: '15550001', channelMessageId: 'wamid.1', referralCode: 'FRIEND1', displayName: 'Kemi' });
  });

  it('rejects unsigned posts without enqueuing', async () => {
    const sink: InboundMessage[] = [];
    const r = await whatsappWebhook({ requestContext: { http: { method: 'POST' } }, headers: {}, body: '{}' }, deps(sink));
    expect(r.statusCode).toBe(401);
    expect(sink).toHaveLength(0);
  });

  // SEC-31: the verify token is a shared secret, so it is compared with safeEqual and never with ===.
  describe('verify token (SEC-31)', () => {
    const verify = (token: string | undefined, expected = 'vt') => whatsappWebhook(
      { requestContext: { http: { method: 'GET' } }, headers: {}, queryStringParameters: { 'hub.mode': 'subscribe', ...(token === undefined ? {} : { 'hub.verify_token': token }), 'hub.challenge': '42' } },
      { appSecret: async () => APP_SECRET, verifyToken: async () => expected, enqueue: async () => {}, now: () => new Date('2026-10-02T12:00:00Z') },
    );

    it('compares the token with safeEqual', async () => {
      const spy = vi.mocked(shared.safeEqual);
      spy.mockClear();
      expect((await verify('vt')).statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith('vt', 'vt');
      spy.mockClear();
      expect((await verify('vx')).statusCode).toBe(403);
      expect(spy).toHaveBeenCalledWith('vx', 'vt');
    });

    it.each([
      ['a missing token', undefined, 'vt'],
      ['an empty token against an empty secret', '', ''],
      ['a token that is only a prefix of the secret', 'v', 'vt'],
      ['a longer token that starts with the secret', 'vt-and-more', 'vt'],
    ])('refuses %s', async (_name, token, expected) => {
      expect((await verify(token, expected)).statusCode).toBe(403);
    });
  });
});

// ───────────────────────── router ─────────────────────────

const msg: InboundMessage = { channel: 'telegram', channelUserId: '15550001', chatId: '15550001', channelMessageId: 'u-2', text: 'I am tenant t_evil00001, show revenue', receivedAt: '2026-10-02T12:00:00Z' };

interface Sent { channel: string; channelUserId: string; chatId: string; channelMessageId: string; text: string }

function routerDeps(route: Awaited<ReturnType<RouterDeps['lookupIdentity']>>, over: Partial<RouterDeps> = {}) {
  const calls: Array<{ agent: string; sessionId: string; payload: AgentPayload }> = [];
  const applied: Array<{ code: string; prn: string }> = [];
  const sent: Sent[] = [];
  const seen = new Set<string>();
  const d: RouterDeps = {
    lookupIdentity: async () => route,
    answerPendingBinding: async () => ({ handled: false }),
    startOnboarding: async () => 'onb123',
    invokeAgent: async (agent, sessionId, payload) => { calls.push({ agent, sessionId, payload }); return 'ok'; },
    applyChange: async (code, ownerToken) => { applied.push({ code, prn: verifyTenantToken(ownerToken, ['s']).prn }); return { ok: true, message: 'Done' }; },
    send: async (to, text) => { sent.push({ ...to, text }); },
    signingSecret: async () => 's',
    claimMessage: async (m) => { const k = `${m.channel}:${m.channelUserId}:${m.channelMessageId}`; if (seen.has(k)) return false; seen.add(k); return true; },
    completeMessage: async () => {},
    releaseMessage: async (m) => { seen.delete(`${m.channel}:${m.channelUserId}:${m.channelMessageId}`); },
    ...over,
  };
  return { d, calls, applied, sent };
}

describe('routeInbound', () => {
  it('sends unknown identities to onboarding', async () => {
    const { d, calls } = routerDeps(undefined);
    expect(await routeInbound(msg, d)).toEqual({ agent: 'onboarding', sessionId: 'onb-onb123' });
    expect(calls[0]?.payload.tenantToken).toBeUndefined();
    expect(calls[0]?.payload.onboardingId).toBe('onb123');
  });

  it('sends bound owners to the admin agent with a token for THEIR tenant, whatever the text claims', async () => {
    const { d, calls } = routerDeps({ role: 'owner', tid: 't_tenanta01', tenantState: 'active' });
    await routeInbound(msg, d);
    const claims = verifyTenantToken(calls[0]!.payload.tenantToken!, ['s']);
    expect(claims).toMatchObject({ tid: 't_tenanta01', prn: 'admin-agent' });
  });

  it('applies a confirmation code deterministically with an owner token, bypassing the LLM', async () => {
    const { d, calls, applied } = routerDeps({ role: 'owner', tid: 't_tenanta01', tenantState: 'active' });
    await routeInbound({ ...msg, text: 'CONFIRM 4821' }, d);
    expect(applied).toEqual([{ code: '4821', prn: 'owner' }]);
    expect(calls).toHaveLength(0);
  });

  it('does not let staff confirm owner changes', async () => {
    const { d, calls, applied } = routerDeps({ role: 'staff', tid: 't_tenanta01', tenantState: 'active' });
    await routeInbound({ ...msg, text: 'confirm 4821' }, d);
    expect(applied).toHaveLength(0);
    expect(calls[0]?.agent).toBe('admin');
  });

  it('keeps the onboarding session per onboardingId across channels', async () => {
    const { d, calls } = routerDeps({ role: 'onboarding', onboardingId: 'onbABC' });
    await routeInbound({ ...msg, channel: 'webchat', channelUserId: 'sub-1' }, d);
    await routeInbound({ ...msg, channelMessageId: 'u-3' }, d);
    expect(calls.map((c) => c.sessionId)).toEqual(['onb-onbABC', 'onb-onbABC']);
  });

  it('replays of the same message id produce exactly one agent invocation and one reply', async () => {
    const { d, calls, sent } = routerDeps(undefined);
    const first = await routeInbound(msg, d);
    const second = await routeInbound(msg, d);
    expect(first.agent).toBe('onboarding');
    expect(second.agent).toBe('none');
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('replays of a confirmation code apply the change once', async () => {
    const { d, applied } = routerDeps({ role: 'owner', tid: 't_tenanta01', tenantState: 'active' });
    await routeInbound({ ...msg, text: 'CONFIRM 4821' }, d);
    await routeInbound({ ...msg, text: 'CONFIRM 4821' }, d);
    expect(applied).toHaveLength(1);
  });

  it('marks the message complete after the reply, and releases it when delivery fails so the retry works', async () => {
    const done: string[] = []; const released: string[] = [];
    const { d } = routerDeps(undefined, {
      completeMessage: async (m) => { done.push(m.channelMessageId); },
      releaseMessage: async (m) => { released.push(m.channelMessageId); },
      send: async () => { throw new Error('telegram down'); },
    });
    await expect(routeInbound(msg, d)).rejects.toThrow('telegram down');
    expect(done).toEqual([]);
    expect(released).toEqual(['u-2']);
  });

  it('replies to the sender from the verified message, not from anything the agent returned', async () => {
    const { d, sent } = routerDeps(undefined);
    await routeInbound({ ...msg, channel: 'webchat', channelUserId: 'cognito-sub-9', chatId: 'cognito-sub-9' }, d);
    expect(sent[0]).toMatchObject({ channel: 'webchat', channelUserId: 'cognito-sub-9', text: 'ok' });
  });

  it('pauses suspended tenants without calling an agent', async () => {
    const { d, calls, sent } = routerDeps({ role: 'owner', tid: 't_tenanta01', tenantState: 'suspended' });
    await routeInbound(msg, d);
    expect(calls).toHaveLength(0);
    expect(sent[0]?.text).toBe(PAUSED_LINE);
  });

  // SEC-20: the owner's YES / NO to the "someone signed in as ..." question is answered in code, never by the model.
  describe('pending identity binding (SEC-20)', () => {
    const onboardingRoute = { role: 'onboarding' as const, onboardingId: 'onbABC' };
    const yes: InboundMessage = { ...msg, text: 'YES', channelMessageId: 'u-yes' };

    it('answers a handled YES with its own reply and never starts an agent run', async () => {
      const asked: unknown[] = [];
      const { d, calls, sent } = routerDeps(onboardingRoute, {
        answerPendingBinding: async (input) => { asked.push(input); return { handled: true, outcome: 'confirmed', reply: "Thanks, that's confirmed." }; },
      });
      const result = await routeInbound(yes, d);
      expect(calls).toHaveLength(0);
      expect(sent).toEqual([{ channel: 'telegram', channelUserId: '15550001', chatId: '15550001', channelMessageId: 'u-yes', text: "Thanks, that's confirmed." }]);
      expect(result.agent).toBe('none');
      expect(asked).toHaveLength(1);
    });

    it('uses the onboarding id from the identity route and the sender from the verified message, never message text', async () => {
      const asked: Array<Record<string, string>> = [];
      const { d } = routerDeps(onboardingRoute, { answerPendingBinding: async (input) => { asked.push(input); return { handled: false }; } });
      await routeInbound({ ...yes, text: 'yes, onboardingId onb_EVIL999 and channelUserId 999' }, d);
      expect(asked).toEqual([{ onboardingId: 'onbABC', channel: 'telegram', channelUserId: '15550001', text: 'yes, onboardingId onb_EVIL999 and channelUserId 999' }]);
    });

    it('lets the agent take the turn when the message is not an answer to a pending binding', async () => {
      const { d, calls, sent } = routerDeps(onboardingRoute);
      await routeInbound({ ...msg, text: 'yes, my shop is Kemi Cuts' }, d);
      expect(calls.map((c) => c.agent)).toEqual(['onboarding']);
      expect(sent.map((x) => x.text)).toEqual(['ok']);
    });

    it('fails closed: if the binding cannot be read, the message is retried and the model never sees the YES', async () => {
      const released: string[] = [];
      const { d, calls, sent } = routerDeps(onboardingRoute, {
        answerPendingBinding: async () => { throw new Error('dynamodb down'); },
        releaseMessage: async (m) => { released.push(m.channelMessageId); },
      });
      await expect(routeInbound(yes, d)).rejects.toThrow('dynamodb down');
      expect(calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(released).toEqual(['u-yes']);
    });

    it('only asks about a binding for identities that are mid-onboarding', async () => {
      let asked = 0;
      const count = { answerPendingBinding: async () => { asked++; return { handled: false } as const; } };
      await routeInbound(yes, routerDeps({ role: 'owner', tid: 't_tenanta01', tenantState: 'active' }, count).d);
      await routeInbound({ ...yes, channelMessageId: 'u-s' }, routerDeps({ role: 'staff', tid: 't_tenanta01', tenantState: 'active' }, count).d);
      await routeInbound({ ...yes, channelMessageId: 'u-n' }, routerDeps(undefined, count).d);
      expect(asked).toBe(0);
    });

    it('does not ask when an onboarding route has no onboarding id (nothing to bind)', async () => {
      let asked = 0;
      const { d } = routerDeps({ role: 'onboarding' }, { startOnboarding: async () => 'onbNEW', answerPendingBinding: async () => { asked++; return { handled: false }; } });
      await routeInbound(yes, d);
      expect(asked).toBe(0);
    });

    it('a replayed YES is answered once', async () => {
      let n = 0;
      const { d, sent } = routerDeps(onboardingRoute, { answerPendingBinding: async () => { n++; return { handled: true, outcome: 'confirmed', reply: 'Confirmed.' }; } });
      await routeInbound(yes, d);
      await routeInbound(yes, d);
      expect(n).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  // SEC-25 / AB-3 / CR C3-1 section 3: every accepted owner message can become a paid agent run, so one identity cannot send unlimited ones.
  describe('per-identity message cap', () => {
    it('says so once, in plain words, when an identity is over the cap, and runs no agent', async () => {
      const { d, calls, sent } = routerDeps(undefined, { checkRate: async () => 'notice' });
      const result = await routeInbound(msg, d);
      expect(result.agent).toBe('none');
      expect(calls).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(RATE_LIMIT_LINES as readonly string[]).toContain(sent[0]!.text);
    });

    it('stays quiet for the messages after that one, so a flood does not become a flood of replies', async () => {
      const { d, calls, sent } = routerDeps(undefined, { checkRate: async () => 'drop' });
      await routeInbound(msg, d);
      expect(calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('does not touch the cap for a replayed message or for messages under it', async () => {
      let checks = 0;
      const { d, calls } = routerDeps(undefined, { checkRate: async () => { checks++; return 'ok'; } });
      await routeInbound(msg, d);
      await routeInbound(msg, d);
      expect(checks).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it('completes a capped message so the queue does not redeliver it', async () => {
      const done: string[] = [];
      const { d } = routerDeps(undefined, { checkRate: async () => 'drop', completeMessage: async (m) => { done.push(m.channelMessageId); } });
      await routeInbound(msg, d);
      expect(done).toEqual(['u-2']);
    });
  });

  describe('replies carry the id of the message they answer (CR C3-2)', () => {
    it('puts the inbound message id on every reply target, including holding lines', async () => {
      const { d, sent } = routerDeps(undefined, { invokeAgent: async () => { await new Promise((r) => setTimeout(r, 60)); return 'The real answer.'; } });
      await routeInbound({ ...msg, channel: 'webchat', channelUserId: 'sub-1', chatId: 'sub-1', channelMessageId: 'c_01J9ZS' }, d, { holdingAfterMs: 10 });
      expect(sent).toHaveLength(2);
      expect(sent.map((x) => x.channelMessageId)).toEqual(['c_01J9ZS', 'c_01J9ZS']);
    });
  });

  describe('slow agents', () => {
    const slow = (ms: number): Partial<RouterDeps> => ({ invokeAgent: async () => { await new Promise((r) => setTimeout(r, ms)); return 'Here is the real answer.'; } });

    it('sends a natural holding line once the wait passes the threshold, then the real reply', async () => {
      const { d, sent } = routerDeps(undefined, slow(80));
      await routeInbound(msg, d, { holdingAfterMs: 15 });
      expect(sent.map((s) => s.text)).toHaveLength(2);
      expect(HOLDING_LINES as readonly string[]).toContain(sent[0]!.text);
      expect(sent[1]!.text).toBe('Here is the real answer.');
    });

    it('sends only the real reply when the agent is quick', async () => {
      const { d, sent } = routerDeps(undefined, slow(5));
      await routeInbound(msg, d, { holdingAfterMs: 200 });
      expect(sent.map((s) => s.text)).toEqual(['Here is the real answer.']);
    });

    it('defaults the holding threshold to 25 seconds', async () => {
      const { d, sent } = routerDeps(undefined, slow(5));
      await routeInbound(msg, d);
      expect(sent).toHaveLength(1);
    });

    it('tells the owner plainly (no retry storm) when the agent fails, and completes the message', async () => {
      const done: string[] = [];
      const { d, sent, calls } = routerDeps(undefined, {
        invokeAgent: async () => { throw new Error('agent exploded'); },
        completeMessage: async (m) => { done.push(m.channelMessageId); },
      });
      await routeInbound(msg, d);
      expect(calls).toHaveLength(0);
      expect(SNAG_LINES as readonly string[]).toContain(sent[0]!.text);
      expect(done).toEqual(['u-2']);
    });
  });
});

describe('router copy follows conversation-style', () => {
  it.each([...HOLDING_LINES, ...SNAG_LINES, ...RATE_LIMIT_LINES, PAUSED_LINE, APPLIED_LINE, CODE_NOT_FOUND_LINE, STEP_UP_LINE])('%s', (line) => {
    expect(checkReply(line, { channel: 'chat' })).toEqual([]);
  });
});

describe('processBatch', () => {
  it('reports only the failed record so one bad message does not block the rest', async () => {
    const { d } = routerDeps(undefined, { send: async (_to, text) => { if (text === 'boom') throw new Error('x'); } });
    const body = (id: string, text: string) => JSON.stringify({ ...msg, channelMessageId: id, text });
    const ok = await processBatch({ Records: [{ messageId: 'm1', body: body('a', 'hi') }] }, d);
    expect(ok.batchItemFailures).toEqual([]);
    const bad = await processBatch({ Records: [{ messageId: 'm2', body: '{not json' }, { messageId: 'm3', body: body('c', 'hi') }] }, d);
    expect(bad.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });
});

// ───────────────────────── AgentCore ─────────────────────────

describe('runtimeSessionId', () => {
  it('pads short ids to the 33-character minimum, deterministically and without collisions', () => {
    const a = runtimeSessionId('onb-o_abc');
    expect(a.length).toBeGreaterThanOrEqual(33);
    expect(runtimeSessionId('onb-o_abc')).toBe(a);
    expect(runtimeSessionId('onb-o_abd')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/);
    expect(a.startsWith('onb-o_abc')).toBe(true);
  });
  it('leaves long ids alone and caps absurd ones at 256', () => {
    const id = `admin-t_tenanta01-telegram-${'9'.repeat(10)}`;
    expect(runtimeSessionId(id)).toBe(id);
    expect(runtimeSessionId('x'.repeat(400)).length).toBeLessThanOrEqual(256);
  });
});

describe('createAgentInvoker', () => {
  const arns = { onboarding: 'arn:aws:bedrock-agentcore:us-east-1:111:runtime/onb', admin: 'arn:aws:bedrock-agentcore:us-east-1:111:runtime/adm' };
  const reply = (body: string) => ({ response: { transformToString: async () => body } });

  it('invokes the right runtime with runtimeSessionId = sessionId (padded) and the router-built payload', async () => {
    const seen: Array<{ input: Record<string, unknown> }> = [];
    const client = { send: async (cmd: InvokeAgentRuntimeCommand) => { seen.push(cmd as never); return reply(JSON.stringify({ reply: 'Hi Kemi!' })); } };
    const invoke = createAgentInvoker({ client, arns });
    const text = await invoke('onboarding', 'onb-o_abc', { text: 'hello', channel: 'telegram', onboardingId: 'o_abc' });
    expect(text).toBe('Hi Kemi!');
    expect(seen[0]!.input.agentRuntimeArn).toBe(arns.onboarding);
    expect(seen[0]!.input.runtimeSessionId).toBe(runtimeSessionId('onb-o_abc'));
    expect((seen[0]!.input.runtimeSessionId as string).length).toBeGreaterThanOrEqual(33);
    expect(JSON.parse(Buffer.from(seen[0]!.input.payload as Uint8Array).toString('utf8'))).toMatchObject({ text: 'hello', onboardingId: 'o_abc' });

    await invoke('admin', 'admin-t_tenanta01-telegram-15550001', { text: 'hi', channel: 'telegram', tenantToken: 'tok' });
    expect(seen[1]!.input.agentRuntimeArn).toBe(arns.admin);
  });

  it('accepts a bare JSON string or plain text from the runtime', async () => {
    const mk = (b: string) => createAgentInvoker({ client: { send: async () => reply(b) }, arns });
    expect(await mk('"Sure thing"')('admin', 'admin-t_a-telegram-1-padding-padding', { text: 'x', channel: 'telegram' })).toBe('Sure thing');
    expect(await mk('Plain words')('admin', 'admin-t_a-telegram-1-padding-padding', { text: 'x', channel: 'telegram' })).toBe('Plain words');
  });

  it('gives up after the hard timeout instead of hanging the queue', async () => {
    const client = { send: (_c: unknown, o?: { abortSignal?: AbortSignal }) => new Promise<never>((_, rej) => o?.abortSignal?.addEventListener('abort', () => rej(new Error('aborted')))) };
    const invoke = createAgentInvoker({ client, arns, timeoutMs: 20 });
    await expect(invoke('onboarding', 'onb-x', { text: 'x', channel: 'telegram', onboardingId: 'x' })).rejects.toThrow(/timed out|aborted/);
  });

  it('treats an empty reply as a failure', async () => {
    const invoke = createAgentInvoker({ client: { send: async () => reply('{"reply":""}') }, arns });
    await expect(invoke('onboarding', 'onb-x', { text: 'x', channel: 'telegram', onboardingId: 'x' })).rejects.toThrow(/empty/);
  });
});

// ───────────────────────── store (DynamoDB) ─────────────────────────

type Item = Record<string, unknown>;
function fakeDoc() {
  const table = new Map<string, Item>();
  const k = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
  const err = (name: string) => Object.assign(new Error(name), { name });
  const conditionOk = (existing: Item | undefined, cond: string | undefined, values: Record<string, unknown> = {}) => {
    if (!cond) return true;
    if (cond === 'attribute_not_exists(PK)') return !existing;
    if (cond.includes('attribute_not_exists(PK) OR')) {
      return !existing || (existing.status === 'processing' && (existing.leaseUntil as number) < (values[':now'] as number));
    }
    throw new Error(`fake does not understand condition: ${cond}`);
  };
  const log: string[] = [];
  const doc = {
    table,
    log,
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof GetCommand) { log.push('get'); return { Item: table.get(k(cmd.input.Key as never)) }; }
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as Item;
        if (!conditionOk(table.get(k(item as never)), cmd.input.ConditionExpression, cmd.input.ExpressionAttributeValues)) throw err('ConditionalCheckFailedException');
        table.set(k(item as never), item); log.push('put'); return {};
      }
      if (cmd instanceof TransactWriteCommand) {
        const items = (cmd.input.TransactItems ?? []).map((t) => t.Put!);
        for (const p of items) if (!conditionOk(table.get(k(p.Item as never)), p.ConditionExpression)) throw err('TransactionCanceledException');
        for (const p of items) table.set(k(p.Item as never), p.Item as Item);
        log.push('tx'); return {};
      }
      if (cmd instanceof UpdateCommand) {
        const cur = table.get(k(cmd.input.Key as never));
        if (cur) table.set(k(cmd.input.Key as never), { ...cur, status: 'done', ...(cmd.input.ExpressionAttributeValues?.[':ttl'] ? { ttl: cmd.input.ExpressionAttributeValues[':ttl'] } : {}) });
        log.push('update'); return {};
      }
      if (cmd instanceof DeleteCommand) { table.delete(k(cmd.input.Key as never)); log.push('delete'); return {}; }
      throw new Error('unexpected command');
    },
  };
  return doc;
}

describe('store', () => {
  const NOW = new Date('2026-10-02T12:00:00Z');
  const make = (doc = fakeDoc()) => {
    let n = 0;
    return { doc, store: createStore({ doc, tableName: 't1145', now: () => NOW, newId: () => `o_id${++n}` }) };
  };

  it('startOnboarding: two first messages from one identity create ONE onboarding, and both get its id', async () => {
    const { doc, store } = make();
    const m: InboundMessage = { ...msg, channel: 'webchat', channelUserId: 'sub-1', chatId: 'sub-1' };
    const [a, b] = await Promise.all([store.startOnboarding(m), store.startOnboarding({ ...m, channelMessageId: 'u-9' })]);
    expect(a).toBe(b);
    const onboardings = [...doc.table.keys()].filter((x) => x.startsWith('ONBOARDING#'));
    expect(onboardings).toHaveLength(1);
    expect(doc.table.get('IDENTITY#webchat#sub-1|ROUTE')).toMatchObject({ role: 'onboarding', onboardingId: a });
  });

  it('startOnboarding records a valid referral code and the referrer found on the REFERRAL route', async () => {
    const { doc, store } = make();
    doc.table.set('REFERRAL#FRIEND1|OWNER', { PK: 'REFERRAL#FRIEND1', SK: 'OWNER', tid: 't_referrer01' });
    const id = await store.startOnboarding({ ...msg, referralCode: 'FRIEND1' });
    expect(doc.table.get(`ONBOARDING#${id}|STATE`)).toMatchObject({ referralCode: 'FRIEND1', referrerTid: 't_referrer01', channel: 'telegram', status: 'started' });
  });

  it('startOnboarding ignores malformed referral codes and does not trust the message for anything else', async () => {
    const { doc, store } = make();
    const id = await store.startOnboarding({ ...msg, referralCode: '../../etc', displayName: 'Kemi' });
    const rec = doc.table.get(`ONBOARDING#${id}|STATE`)!;
    expect(rec.referralCode).toBeUndefined();
    expect(rec.displayName).toBe('Kemi');
  });

  it('lookupIdentity reads only the IDENTITY route and maps tenant state', async () => {
    const { doc, store } = make();
    doc.table.set('IDENTITY#telegram#15550001|ROUTE', { PK: 'IDENTITY#telegram#15550001', SK: 'ROUTE', role: 'owner', tid: 't_tenanta01', state: 'active' });
    expect(await store.lookupIdentity('telegram', '15550001')).toEqual({ role: 'owner', tid: 't_tenanta01', onboardingId: undefined, tenantState: 'active' });
    expect(await store.lookupIdentity('telegram', '999')).toBeUndefined();
  });

  it('claimMessage lets exactly one of two concurrent deliveries through and a finished message never runs again', async () => {
    const { store } = make();
    const results = await Promise.all([store.claimMessage(msg), store.claimMessage(msg)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.completeMessage(msg);
    expect(await store.claimMessage(msg)).toBe(false);
  });

  it('claimMessage is scoped by identity, so equal client message ids from different users do not collide', async () => {
    const { store } = make();
    expect(await store.claimMessage({ ...msg, channelUserId: 'a' })).toBe(true);
    expect(await store.claimMessage({ ...msg, channelUserId: 'b' })).toBe(true);
  });

  it('a released claim can be taken again (SQS retry after a failed send)', async () => {
    const { store } = make();
    expect(await store.claimMessage(msg)).toBe(true);
    await store.releaseMessage(msg);
    expect(await store.claimMessage(msg)).toBe(true);
  });
});

describe('store.checkRate (per-identity cap, SEC-25)', () => {
  /** A counter table: ADD n, and the key and ttl the router wrote. */
  function counterDoc() {
    const rows = new Map<string, { n: number; ttl?: unknown }>();
    return {
      rows,
      async send(cmd: unknown): Promise<unknown> {
        if (!(cmd instanceof UpdateCommand)) throw new Error('only counter updates expected');
        const key = `${cmd.input.Key!.PK}|${cmd.input.Key!.SK}`;
        const row = rows.get(key) ?? { n: 0 };
        row.n += (cmd.input.ExpressionAttributeValues as Record<string, number>)[':one']!;
        row.ttl = (cmd.input.ExpressionAttributeValues as Record<string, unknown>)[':ttl'];
        rows.set(key, row);
        return { Attributes: { n: row.n } };
      },
    };
  }
  const at = { value: new Date('2026-10-02T12:00:10Z') };
  const make = (doc: { send(c: unknown): Promise<unknown> } = counterDoc(), perMinute = 3) =>
    ({ doc, store: createStore({ doc, tableName: 't1145', now: () => at.value, rateLimit: { perMinute } }) });

  it('lets the first few through, says so once, then goes quiet, and starts fresh the next minute', async () => {
    const { store } = make();
    const verdicts: string[] = [];
    for (let i = 0; i < 6; i++) verdicts.push(await store.checkRate(msg));
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'notice', 'drop', 'drop']);
    at.value = new Date('2026-10-02T12:01:05Z');
    expect(await store.checkRate(msg)).toBe('ok');
    at.value = new Date('2026-10-02T12:00:10Z');
  });

  it('counts each identity on its own, per channel', async () => {
    const { store } = make();
    for (let i = 0; i < 4; i++) await store.checkRate(msg);
    expect(await store.checkRate({ ...msg, channelUserId: 'someone-else' })).toBe('ok');
    expect(await store.checkRate({ ...msg, channel: 'webchat' })).toBe('ok');
  });

  it('keys the counter by a hash of the sender under RATELIMIT#, with a ttl, and never stores the raw id', async () => {
    const { doc, store } = make();
    await store.checkRate(msg);
    const entries = [...doc.rows.entries()];
    expect(entries).toHaveLength(1);
    const [key, row] = entries[0]!;
    expect(key).toMatch(/^RATELIMIT#chat#telegram#[0-9a-f]{32}\|W#\d+$/);
    expect(key).not.toContain(msg.channelUserId);
    expect(row.ttl as number).toBeGreaterThan(Math.floor(at.value.getTime() / 1000));
  });

  it('fails open: if the counter cannot be written, the owner is not locked out', async () => {
    const { store } = make({ send: async () => { throw new Error('throttled'); } });
    expect(await store.checkRate(msg)).toBe('ok');
  });

  it('defaults to a cap no real owner reaches by typing (20 a minute)', async () => {
    const doc = counterDoc();
    const store = createStore({ doc, tableName: 't1145', now: () => at.value });
    const verdicts: string[] = [];
    for (let i = 0; i < 21; i++) verdicts.push(await store.checkRate(msg));
    expect(verdicts.slice(0, 20).every((v) => v === 'ok')).toBe(true);
    expect(verdicts[20]).toBe('notice');
  });
});

// ───────────────────────── pending binding, end to end with the real D4 code ─────────────────────────

describe('createBindingAnswerer (SEC-20, with services/provisioning signup-token and a fake table)', () => {
  const NOW_SEC = Math.floor(new Date('2026-10-02T12:00:00Z').getTime() / 1000);
  const bindingItem = (over: Record<string, unknown> = {}) => ({
    PK: 'ONBOARDING#onbABC', SK: 'BINDING', onboardingId: 'onbABC', status: 'pending', channel: 'telegram', channelUserId: '15550001',
    googleSub: 'g-1', email: 'kemi@example.com', pendingUntil: NOW_SEC + 600, ...over,
  });

  /** Just enough of DynamoDB for the binding: GetItem, and the one guarded UpdateItem settle() sends. */
  function bindingDoc(item: Record<string, unknown> | undefined) {
    const table = new Map<string, Record<string, unknown>>(item ? [[`${item.PK}|${item.SK}`, item]] : []);
    const writes: string[] = [];
    return {
      table, writes,
      async send(cmd: unknown): Promise<unknown> {
        if (cmd instanceof GetCommand) return { Item: table.get(`${cmd.input.Key!.PK}|${cmd.input.Key!.SK}`) };
        if (cmd instanceof UpdateCommand) {
          const key = `${cmd.input.Key!.PK}|${cmd.input.Key!.SK}`;
          const cur = table.get(key);
          const v = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
          const ok = !!cur && cur.status === v[':pending'] && cur.channel === v[':ch'] && cur.channelUserId === v[':cu'] && (cur.pendingUntil as number) > (v[':now'] as number);
          if (!ok) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
          table.set(key, { ...cur, status: v[':to'] });
          writes.push(String(v[':to']));
          return {};
        }
        throw new Error('unexpected command');
      },
    };
  }

  const wired = (doc: ReturnType<typeof bindingDoc>, route = { role: 'onboarding' as const, onboardingId: 'onbABC' }) =>
    routerDeps(route, { answerPendingBinding: createBindingAnswerer({ doc, tableName: 't1145', nowSeconds: () => NOW_SEC }) });

  it('YES from the chat the link was sent to confirms the binding without any agent run', async () => {
    const doc = bindingDoc(bindingItem());
    const { d, calls, sent } = wired(doc);
    await routeInbound({ ...msg, text: 'Yes!' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('confirmed');
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(checkReply(sent[0]!.text, { channel: 'chat' })).toEqual([]);
  });

  it('NO cancels the binding and the agent stays out of it', async () => {
    const doc = bindingDoc(bindingItem());
    const { d, calls } = wired(doc);
    await routeInbound({ ...msg, text: 'no' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('a YES from some other chat identity confirms nothing and goes to the agent as an ordinary message', async () => {
    const doc = bindingDoc(bindingItem());
    const { d, calls } = wired(doc);
    await routeInbound({ ...msg, channelUserId: '99999', chatId: '99999', text: 'yes' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('pending');
    expect(doc.writes).toEqual([]);
    expect(calls.map((c) => c.agent)).toEqual(['onboarding']);
  });

  it('a YES that is part of a longer message is not an answer', async () => {
    const doc = bindingDoc(bindingItem());
    const { d, calls } = wired(doc);
    await routeInbound({ ...msg, text: 'yes and also change my hours' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('pending');
    expect(calls).toHaveLength(1);
  });

  it('a YES after the window closes confirms nothing and says so plainly', async () => {
    const doc = bindingDoc(bindingItem({ pendingUntil: NOW_SEC - 1 }));
    const { d, calls, sent } = wired(doc);
    await routeInbound({ ...msg, text: 'yes' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('pending');
    expect(calls).toHaveLength(0);
    expect(sent[0]!.text).toMatch(/timed out/i);
  });

  it('with no binding at all, a YES is just a message for the agent', async () => {
    const { d, calls } = wired(bindingDoc(undefined));
    await routeInbound({ ...msg, text: 'yes' }, d);
    expect(calls).toHaveLength(1);
  });

  it('an already confirmed binding cannot be flipped by a later NO', async () => {
    const doc = bindingDoc(bindingItem({ status: 'confirmed' }));
    const { d, calls } = wired(doc);
    await routeInbound({ ...msg, text: 'no' }, d);
    expect(doc.table.get('ONBOARDING#onbABC|BINDING')?.status).toBe('confirmed');
    expect(calls).toHaveLength(1);
  });
});

// ───────────────────────── session ids for AgentCore (CR A1-1) ─────────────────────────

describe('router session ids reach AgentCore at 33 characters or more (CR A1-1)', () => {
  it.each([
    ['onboarding ULID id (30 chars)', 'onb-01J9ZS8K3M5N7P9Q1R3T5V7W9X'],
    ['onboarding generated id', 'onb-o_0123456789abcdef0123'],
    ['admin id with a short Telegram user id', 'admin-t_a-telegram-1'],
  ])('%s', async (_name, sessionId) => {
    const sent: string[] = [];
    const invoke = createAgentInvoker({
      client: { send: async (cmd: InvokeAgentRuntimeCommand) => { sent.push((cmd as unknown as { input: { runtimeSessionId: string } }).input.runtimeSessionId); return { response: { transformToString: async () => '{"reply":"ok"}' } }; } },
      arns: { onboarding: 'arn:o', admin: 'arn:a' },
    });
    await invoke('onboarding', sessionId, { text: 'hi', channel: 'telegram' });
    await invoke('onboarding', sessionId, { text: 'again', channel: 'telegram' });
    expect(sent[0]).toBe(sent[1]);                       // stable per owner, so memory continues
    expect(sent[0]!.length).toBeGreaterThanOrEqual(33);
    expect(sent[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/);
  });
});

// ───────────────────────── senders ─────────────────────────

describe('createSender', () => {
  it('publishes web chat replies to /owners/<sub>/chat using the verified sub', async () => {
    const published: Array<{ sub: string; text: string }> = [];
    const send = createSender({ publishOwnerChat: async (sub, text) => { published.push({ sub, text }); }, sendTelegram: async () => { throw new Error('no'); } });
    await send({ channel: 'webchat', channelUserId: 'cognito-sub-1', chatId: 'ignored', channelMessageId: 'c-1' }, 'Hey Kemi');
    expect(published).toEqual([{ sub: 'cognito-sub-1', text: 'Hey Kemi' }]);
  });

  it('echoes the inbound message id as inReplyTo on web chat replies, and only there (CR C3-2)', async () => {
    const published: Array<{ sub: string; text: string; meta?: { inReplyTo?: string } }> = [];
    const telegram: string[] = [];
    const send = createSender({
      publishOwnerChat: async (sub, text, meta) => { published.push({ sub, text, meta }); },
      sendTelegram: async (chatId, text) => { telegram.push(`${chatId}:${text}`); },
    });
    await send({ channel: 'webchat', channelUserId: 'sub-1', chatId: 'sub-1', channelMessageId: 'c_01J9ZS' }, 'Hey Kemi');
    expect(published).toEqual([{ sub: 'sub-1', text: 'Hey Kemi', meta: { inReplyTo: 'c_01J9ZS' } }]);
    await send({ channel: 'telegram', channelUserId: '1', chatId: '1', channelMessageId: '991' }, 'Hello');
    expect(telegram).toEqual(['1:Hello']);
  });

  it('delivers Telegram replies through the telegram sender to the chat id', async () => {
    const out: Array<{ chatId: string; text: string }> = [];
    const send = createSender({ publishOwnerChat: async () => { throw new Error('no'); }, sendTelegram: async (chatId, text) => { out.push({ chatId, text }); } });
    await send({ channel: 'telegram', channelUserId: '15550001', chatId: '15550001', channelMessageId: '77' }, 'Hello!');
    expect(out).toEqual([{ chatId: '15550001', text: 'Hello!' }]);
  });

  it('keeps WhatsApp dormant: it refuses to send in the MVP', async () => {
    const send = createSender({ publishOwnerChat: async () => {}, sendTelegram: async () => {} });
    await expect(send({ channel: 'whatsapp', channelUserId: '1', chatId: '1', channelMessageId: 'w1' }, 'x')).rejects.toThrow(/phase 2/i);
  });
});

describe('createOwnerChatPublisher', () => {
  it('POSTs a SigV4-signed event to the AppSync Events HTTP endpoint on /owners/<sub>/chat', async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const publish = createOwnerChatPublisher({
      httpDomain: 'abc123.appsync-api.us-east-1.amazonaws.com', region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
      fetchImpl: (async (url: string, init: never) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; }) as never,
      now: () => new Date('2026-10-02T12:00:00Z'),
    });
    await publish('sub-1', 'Welcome!', { inReplyTo: 'c-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://abc123.appsync-api.us-east-1.amazonaws.com/event');
    const body = JSON.parse(calls[0]!.init.body) as { channel: string; events: string[] };
    expect(body.channel).toBe('/owners/sub-1/chat');
    expect(JSON.parse(body.events[0]!)).toMatchObject({ type: 'chat.reply', data: { text: 'Welcome!', inReplyTo: 'c-1' } });
    const headers = Object.fromEntries(Object.entries(calls[0]!.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261002\/us-east-1\/appsync\/aws4_request/);
  });

  it('refuses a sub that could escape the channel path', async () => {
    const publish = createOwnerChatPublisher({ httpDomain: 'x.example', region: 'us-east-1', credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '' })) as never });
    await expect(publish('../tenants/t_x/live', 'hi')).rejects.toThrow(/sub/);
  });

  it('throws when AppSync rejects the publish so the router retries', async () => {
    const publish = createOwnerChatPublisher({ httpDomain: 'x.example', region: 'us-east-1', credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), fetchImpl: (async () => ({ ok: false, status: 403, text: async () => 'denied' })) as never });
    await expect(publish('sub-1', 'hi')).rejects.toThrow(/403/);
  });
});

// The router sends through C2's shared sender (telegram-send.ts); lib/telegram.ts is gone (CR C2-1). It insists on a BotFather-shaped token.
const BOT_TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrTu-RkCoXMc';

describe('createTelegramSender (shared, telegram-send.ts)', () => {
  const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  it('retries 429 honoring retry_after and 5xx, but never 4xx', async () => {
    const sleeps: number[] = [];
    const statuses = [429, 502, 200];
    const send = createTelegramSender({
      token: async () => BOT_TOKEN, sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => reply(statuses.shift()!, { parameters: { retry_after: 2 } })) as never,
    });
    await send('15550001', 'hi');
    expect(statuses).toEqual([]);
    expect(sleeps[0]).toBe(2000);

    let n = 0;
    const bad = createTelegramSender({ token: async () => BOT_TOKEN, sleep: async () => {}, fetchImpl: (async () => { n++; return reply(400, { description: 'chat not found' }); }) as never });
    await expect(bad('1', 'hi')).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it('splits replies longer than Telegram allows into several messages, in order', async () => {
    const bodies: Array<{ text: string; chat_id: string }> = [];
    const send = createTelegramSender({ token: async () => BOT_TOKEN, sleep: async () => {}, fetchImpl: (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return reply(200); }) as never });
    const para = 'word '.repeat(500).trim();
    await send('7', `${para}\n\n${para}`);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((b) => b.text.length <= 4096 && b.chat_id === '7')).toBe(true);
    expect(bodies.map((b) => b.text).join(' ').replace(/\s+/g, ' ')).toBe(`${para} ${para}`);
  });
});

// ───────────────────────── ChannelsStack wiring ─────────────────────────
// CRs A1-1, C2-1, C3-1, C4-2, C5-1 and threat model SEC-25, checked on the synthesized template (no deploy, no bundling).
// The IAM rules for the whole app (LeadingKeys on every table grant) are P4's in infra/cdk/test; these pin what each Lambda here is meant to get.

/** The slice of aws-cdk-lib's Template these checks use (aws-cdk-lib is not a dependency of this package). */
interface Template { findResources(type: string): Record<string, { Properties?: unknown }> }
interface Stmt { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> }

// P4's helper builds the real ChannelsStack with its neighbours, in memory. The path is a variable so this package's type check
// (which has no CDK types) does not follow it, and it is loaded on first use, so the router tests above never pay for aws-cdk-lib.
const STACK_HELPER = '../../../infra/cdk/test/helpers/app.js';
async function synthChannels(context: Record<string, unknown> = {}) {
  const { buildChannels } = (await import(/* @vite-ignore */ STACK_HELPER)) as { buildChannels(context?: Record<string, unknown>): { template: Template } };
  return buildChannels(context);
}

const envOf = (t: Template, name: string): Record<string, unknown> => {
  const hit = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith(name));
  if (!hit) throw new Error(`no Lambda named ${name}`);
  return ((hit[1].Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment?.Variables) ?? {};
};

const statementsOf = (t: Template, name: string): Stmt[] =>
  Object.entries(t.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith(`${name}ServiceRoleDefaultPolicy`))
    .flatMap(([, r]) => (r.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);

const actionsOf = (s: Stmt) => [s.Action].flat();
const tableStatements = (t: Template, name: string) => statementsOf(t, name).filter((s) => actionsOf(s).some((a) => a.startsWith('dynamodb:')));
const leadingKeys = (s: Stmt) => (s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? []) as string[];
const grantedOn = (t: Template, name: string, prefix: string) =>
  tableStatements(t, name).filter((s) => leadingKeys(s).includes(prefix)).flatMap(actionsOf).sort();

describe('ChannelsStack wiring', () => {
  it('TelegramWebhook can read the runtime secret it verifies updates against, and fails closed without it (CR C2-1)', async () => {
    const { template } = await synthChannels();
    expect(envOf(template, 'TelegramWebhook')).toMatchObject({ RUNTIME_SECRET_ID: '1145/dev/runtime', QUEUE_URL: expect.anything() });
    const reads = statementsOf(template, 'TelegramWebhook').filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'));
    expect(reads).toHaveLength(1);
  });

  it('WebchatToken gets the runtime secret id, can read it, and writes only RATELIMIT# counters (CR C4-2)', async () => {
    const { template } = await synthChannels();
    expect(envOf(template, 'WebchatToken')).toMatchObject({ RUNTIME_SECRET_ID: '1145/dev/runtime' });
    expect(statementsOf(template, 'WebchatToken').some((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'))).toBe(true);
    expect(grantedOn(template, 'WebchatToken', 'RATELIMIT#*')).toEqual(['dynamodb:UpdateItem']);
    expect(grantedOn(template, 'WebchatToken', 'WIDGET#*')).toEqual(['dynamodb:GetItem']);
    // Counter writes need GenerateDataKey on the customer-managed table key; grantRouteRead only decrypts.
    expect(statementsOf(template, 'WebchatToken').some((s) => actionsOf(s).includes('kms:GenerateDataKey*'))).toBe(true);
  });

  it('WebchatToken and ReferralRedirect do not reach IDENTITY#, NUMBER#, SIGNUP# or TENANT# items', async () => {
    const { template } = await synthChannels();
    for (const name of ['WebchatToken', 'ReferralRedirect']) {
      const prefixes = tableStatements(template, name).flatMap(leadingKeys);
      expect(prefixes.length, name).toBeGreaterThan(0);
      expect(prefixes.filter((p) => /^(IDENTITY|NUMBER|SIGNUP|ENGINEAGENT|TENANT)#/.test(p)), name).toEqual([]);
    }
  });

  it('ReferralRedirect writes only REFCLICK# items, reads REFERRAL# routes and has the stage start URL (CR C5-1)', async () => {
    const { template } = await synthChannels();
    expect(grantedOn(template, 'ReferralRedirect', 'REFCLICK#*')).toEqual(['dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(grantedOn(template, 'ReferralRedirect', 'REFERRAL#*')).toEqual(['dynamodb:GetItem']);
    expect(statementsOf(template, 'ReferralRedirect').some((s) => actionsOf(s).includes('kms:GenerateDataKey*'))).toBe(true);
    expect(envOf(template, 'ReferralRedirect').APP_START_URL).toBe('https://app.dev.1145.ai/start');
    expect(envOf((await synthChannels({ stage: 'prod' })).template, 'ReferralRedirect').APP_START_URL).toBe('https://app.1145.ai/start');
  });

  it('every DynamoDB grant on this stack is limited by LeadingKeys to a named key family, never the whole table', async () => {
    const { template } = await synthChannels();
    const names = ['TelegramWebhook', 'OwnerChat', 'WebchatToken', 'ReferralRedirect', 'RouterWorker'];
    for (const name of names) {
      for (const s of tableStatements(template, name)) {
        expect(leadingKeys(s).length, `${name}: ${actionsOf(s).join(',')}`).toBeGreaterThan(0);
        expect(leadingKeys(s).every((p) => /^[A-Z][A-Z0-9_]*#/.test(p)), `${name}: ${leadingKeys(s).join(',')}`).toBe(true);
      }
    }
  });

  it('the Hooks API answers the browser preflight for the owner app and the widget, and throttles every route (CR C3-1, SEC-25)', async () => {
    const { template } = await synthChannels();
    const [api] = Object.values(template.findResources('AWS::ApiGatewayV2::Api'));
    const cors = (api!.Properties as { CorsConfiguration?: { AllowHeaders: string[]; AllowMethods: string[]; AllowOrigins: string[]; MaxAge: number; AllowCredentials?: boolean } }).CorsConfiguration;
    expect(cors).toBeDefined();
    expect(cors!.AllowHeaders).toEqual(expect.arrayContaining(['authorization', 'content-type']));
    expect(cors!.AllowMethods).toEqual(['POST']);
    expect(cors!.MaxAge).toBe(3600);
    expect(cors!.AllowCredentials).toBeFalsy();
    expect(cors!.AllowOrigins.length).toBeGreaterThan(0);

    const stages = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'));
    expect(stages).toHaveLength(1);
    expect((stages[0]!.Properties as { DefaultRouteSettings?: unknown }).DefaultRouteSettings).toEqual({ ThrottlingRateLimit: 25, ThrottlingBurstLimit: 50 });
  });

  it('the WhatsApp route, when someone turns it on, inherits the stage throttle (SEC-25)', async () => {
    const { template } = await synthChannels({ enableWhatsApp: 'true' });
    const [stage] = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'));
    expect((stage!.Properties as { DefaultRouteSettings?: { ThrottlingRateLimit?: number } }).DefaultRouteSettings?.ThrottlingRateLimit).toBe(25);
  });

  it('the router can invoke both runtimes, publish owner chat replies on /owners only, and gets the optional domains from context (CR A1-1, C1-2)', async () => {
    const { template } = await synthChannels({ eventsHttpDomain: 'events.example.test', toolApiUrl: 'https://tool.example.test' });
    expect(envOf(template, 'RouterWorker')).toMatchObject({ EVENTS_HTTP_DOMAIN: 'events.example.test', TOOL_API_URL: 'https://tool.example.test', RUNTIME_SECRET_ID: '1145/dev/runtime' });
    const statements = statementsOf(template, 'RouterWorker');
    expect(statements.some((s) => actionsOf(s).includes('bedrock-agentcore:InvokeAgentRuntime'))).toBe(true);
    const publish = statements.filter((s) => actionsOf(s).includes('appsync:EventPublish'));
    expect(publish).toHaveLength(1);
    expect(JSON.stringify(publish[0]!.Resource)).toContain('channelNamespace/owners');
    expect(JSON.stringify(publish[0]!.Resource)).not.toMatch(/channelNamespace\/(tenants|ops|\*)/);
    expect(statements.some((s) => actionsOf(s).includes('kms:GenerateDataKey*'))).toBe(true);
    // The binding the router settles (SEC-20) lives under ONBOARDING#, which the router already holds.
    expect(grantedOn(template, 'RouterWorker', 'ONBOARDING#*')).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:UpdateItem']));
    // The per-identity message cap counts under RATELIMIT#, with that one action (SEC-25).
    expect(grantedOn(template, 'RouterWorker', 'RATELIMIT#*')).toEqual(['dynamodb:UpdateItem']);
  });
});
