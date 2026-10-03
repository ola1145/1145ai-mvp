import { describe, expect, it } from 'vitest';
import { asTenantId, makeEvent } from '@1145/shared';
import { channelFor, publishEnvelope, sanitize, handleEventBridge, signedSender, type Sender } from '../src/publish.js';

const TID = 't_tenanta01';
const OWNER_SUB = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const ctx = { tenantId: asTenantId(TID), correlationId: 'call-1' };

function recorder() {
  const sent: Array<{ channel: string; events: unknown[] }> = [];
  const send: Sender = async (channel, events) => { sent.push({ channel, events: events.map((e) => JSON.parse(e)) }); };
  return { sent, send };
}

describe('channelFor: event -> channel', () => {
  it('maps tenant events to /tenants/<tid>/live', () => {
    for (const t of ['call.started', 'call.ended', 'booking.created', 'booking.updated', 'booking.cancelled', 'message.taken', 'handoff.requested', 'onboarding.status'] as const) {
      expect(channelFor(makeEvent(t, ctx, {}))).toBe(`/tenants/${TID}/live`);
    }
  });
  it('maps owner chat replies to /owners/<sub>/chat and never to the tenant channel', () => {
    const e = makeEvent('conversation.message', ctx, { audience: 'owner_chat', ownerSub: OWNER_SUB, text: 'Done, I moved her to 3pm.' });
    expect(channelFor(e)).toBe(`/owners/${OWNER_SUB}/chat`);
  });
  it('maps tenant.state_changed to /ops/fleet', () => {
    expect(channelFor(makeEvent('tenant.state_changed', ctx, { state: 'active' }))).toBe('/ops/fleet');
  });
  it('ignores internal-only event types', () => {
    for (const t of ['usage.recorded', 'tenant.provisioned', 'channel.unlock_changed', 'admin.change_applied'] as const) {
      expect(channelFor(makeEvent(t, ctx, {}))).toBeNull();
    }
  });
  it('refuses a tenant id that could escape the channel path', () => {
    const e = { ...makeEvent('booking.created', ctx, {}), tenantId: 't_x/../owners/zzz' as never };
    expect(channelFor(e)).toBeNull();
  });
  it('refuses an owner sub that is not a Cognito sub', () => {
    const e = makeEvent('conversation.message', ctx, { audience: 'owner_chat', ownerSub: '../tenants/t_tenantb01', text: 'hi' });
    expect(channelFor(e)).toBeNull();
  });
  it('owner chat without an owner sub is dropped, not leaked to the tenant channel', () => {
    const e = makeEvent('conversation.message', ctx, { audience: 'owner_chat', text: 'hi' });
    expect(channelFor(e)).toBeNull();
  });
});

describe('sanitize: masking and internal fields', () => {
  it('masks phone fields and phone numbers inside free text', () => {
    const out = sanitize({
      callerE164: '+14155550134',
      phone: '4155550134',
      callerMasked: '+1••••••1234',
      summary: 'Maria (+14155550134) wants a cut. Call back on (415) 555-0199.',
      start: '2026-10-03T10:00:00Z',
      count: 1700000000,
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/4155550134|415\) 555-0199|5550199/);
    expect(out.callerMasked).toBe('+1••••••1234');
    expect(out.start).toBe('2026-10-03T10:00:00Z');
    expect(out.count).toBe(1700000000);
    expect(out.callerE164).toBe('+1••••••0134');
    expect(String(out.summary)).toContain('+1••••••0134');
  });
  it('drops internal fields at every depth', () => {
    const out = sanitize({
      callId: 'c1',
      transcriptKey: 'tenant/x/transcript.json',
      engineConversationId: 'el_123',
      pk: 'TENANT#t_x', sk: 'CALL#1',
      nested: { token: 'abc', _trace: 'x', internalNote: 'x', keep: 'yes', list: [{ apiKey: 'k', ok: 1 }] },
    }) as Record<string, unknown>;
    expect(out).toEqual({ callId: 'c1', nested: { keep: 'yes', list: [{ ok: 1 }] } });
  });
});

describe('publishEnvelope', () => {
  it('publishes a masked, trimmed payload to the tenant channel', async () => {
    const { sent, send } = recorder();
    const e = makeEvent('call.ended', ctx, { callId: 'call-1', durationSec: 95, endReason: 'caller_hangup', transcriptKey: 'k', engineConversationId: 'el_1', callerE164: '+14155550134' });
    const r = await publishEnvelope(e, send);
    expect(r).toEqual({ published: true, channel: `/tenants/${TID}/live` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(`/tenants/${TID}/live`);
    const p = sent[0]!.events[0] as Record<string, unknown>;
    expect(p.type).toBe('call.ended');
    expect(p.tenantId).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/transcriptKey|engineConversationId|4155550134/);
    expect(p.data).toMatchObject({ callId: 'call-1', durationSec: 95, endReason: 'caller_hangup' });
  });
  it('owner chat replies go to the owner channel and the owner sub is not echoed in the payload', async () => {
    const { sent, send } = recorder();
    await publishEnvelope(makeEvent('conversation.message', ctx, { audience: 'owner_chat', ownerSub: OWNER_SUB, text: 'Booked Maria for 3pm.' }), send);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(`/owners/${OWNER_SUB}/chat`);
    expect(JSON.stringify(sent[0]!.events[0])).not.toContain(OWNER_SUB);
    expect(JSON.stringify(sent[0]!.events[0])).toContain('Booked Maria for 3pm.');
  });
  it('skips events with no channel without calling AppSync', async () => {
    const { sent, send } = recorder();
    const r = await publishEnvelope(makeEvent('usage.recorded', ctx, { callId: 'c' }), send);
    expect(r.published).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('propagates send failures so EventBridge/Lambda retries', async () => {
    await expect(publishEnvelope(makeEvent('booking.created', ctx, {}), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('handleEventBridge', () => {
  const wrap = (detailType: string, detail: unknown, source = '1145.tool-api') => ({ 'detail-type': detailType, source, detail });
  it('publishes a valid envelope', async () => {
    const { sent, send } = recorder();
    const r = await handleEventBridge(wrap('booking.created', makeEvent('booking.created', ctx, { bookingId: 'b1' })), send);
    expect(r.published).toBe(true);
    expect(sent[0]!.channel).toBe(`/tenants/${TID}/live`);
  });
  it('rejects a detail-type that disagrees with the envelope type', async () => {
    const { sent, send } = recorder();
    const r = await handleEventBridge(wrap('booking.created', makeEvent('call.ended', ctx, {})), send);
    expect(r.published).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('rejects events whose source is not a 1145 service', async () => {
    const { sent, send } = recorder();
    const r = await handleEventBridge(wrap('booking.created', makeEvent('booking.created', ctx, {}), 'aws.partner'), send);
    expect(r.published).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('rejects malformed input without throwing', async () => {
    const { send } = recorder();
    expect((await handleEventBridge(null, send)).published).toBe(false);
    expect((await handleEventBridge(wrap('booking.created', 'nope'), send)).published).toBe(false);
  });
});

describe('signedSender (SigV4 to the AppSync Events HTTP endpoint)', () => {
  it('POSTs {channel, events[]} as JSON strings, signed for appsync', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ successful: [{ identifier: 'a', index: 0 }], failed: [] }), { status: 200 }); }) as unknown as typeof fetch;
    const send = signedSender({
      host: 'abc.appsync-api.us-east-1.amazonaws.com',
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-for-test', sessionToken: 'tok' }),
      fetchFn,
      now: () => new Date('2026-10-03T00:00:00Z'),
    });
    await send('/tenants/t_tenanta01/live', ['{"a":1}']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://abc.appsync-api.us-east-1.amazonaws.com/event');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: '/tenants/t_tenanta01/live', events: ['{"a":1}'] });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization ?? h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261003\/us-east-1\/appsync\/aws4_request/);
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h['content-type'] ?? h['Content-Type']).toMatch(/application\/json/);
  });
  it('throws on a non-2xx response and on per-event failures', async () => {
    const mk = (res: Response) => signedSender({ host: 'h', region: 'us-east-1', credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), fetchFn: (async () => res) as unknown as typeof fetch });
    await expect(mk(new Response('no', { status: 403 }))('/tenants/t_x/live', ['{}'])).rejects.toThrow(/403/);
    await expect(mk(new Response(JSON.stringify({ successful: [], failed: [{ index: 0, errorCode: 'x' }] }), { status: 200 }))('/tenants/t_x/live', ['{}'])).rejects.toThrow(/failed/);
  });
});
