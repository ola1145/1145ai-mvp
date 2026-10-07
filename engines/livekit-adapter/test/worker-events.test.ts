import { describe, expect, it } from 'vitest';
import { mintTenantToken, type NormalizedCallEvent, type Principal } from '@1145/shared';
import {
  createLiveKitAdapterDeps, UnsupportedEventError, WorkerEventAuthError, WorkerEventError,
  type LiveKitAdapterConfig, type LiveKitAdapterPorts,
} from '../src/index.js';
import { CONNECTION_ID, NOW, OLD_SECRET, OTHER, SECRET, TENANT, TRUNK_ID, fakePorts, fakeWebhooks } from './fakes.js';

const CALL = 'SCL_call_01';
const OCCURRED = '2027-01-15T08:00:00.000Z';

function verifier(opts: { secrets?: string[]; ports?: Partial<LiveKitAdapterPorts> } = {}) {
  const config: LiveKitAdapterConfig = {
    telnyxConnectionId: CONNECTION_ID, outboundTrunkId: TRUNK_ID, tokenSecrets: async () => opts.secrets ?? [SECRET, OLD_SECRET],
    now: () => new Date(NOW * 1000),
  };
  const deps = createLiveKitAdapterDeps(config, { ...fakePorts().ports, ...opts.ports });
  return (body: string, headers: Record<string, string | undefined>) => deps.verifyWorkerEvent(body, headers);
}

function token(claims: { tid?: string; prn?: Principal; cid?: string } = {}, secret = SECRET, ttl = 3600, at = NOW) {
  return mintTenantToken({ tid: claims.tid ?? TENANT, prn: claims.prn ?? 'customer-agent', cid: claims.cid ?? CALL, ch: 'voice' }, secret, ttl, at);
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** The envelope engines/livekit-agent/src/frontdesk/events.py publishes (type, version, tenantId, correlationId, occurredAt, data). */
function envelope(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type, version: 1, tenantId: TENANT, correlationId: CALL, occurredAt: OCCURRED, data, ...extra });
}

describe('worker events are verified with the 1145 service token', () => {
  it('maps call.started, taking the tenant from the token', async () => {
    const ev = await verifier()(envelope('call.started', { callId: CALL, engine: 'livekit-telnyx', channel: 'voice', callerMasked: '***0123' }), bearer(token()));
    expect(ev).toMatchObject<Partial<NormalizedCallEvent>>({
      type: 'call.started', engine: 'livekit-telnyx', tenantId: TENANT, callId: CALL, occurredAt: OCCURRED,
    });
  });

  it('maps call.ended with its duration', async () => {
    const ev = await verifier()(
      envelope('call.ended', { callId: CALL, durationSec: 42, endReason: 'caller_hangup', transcriptKey: `tenants/${TENANT}/transcripts/${CALL}.json` }),
      bearer(token()));
    expect(ev).toMatchObject({ type: 'call.ended', tenantId: TENANT, callId: CALL, durationSec: 42 });
  });

  it('maps a transcript.partial turn', async () => {
    const ev = await verifier()(envelope('transcript.partial', { callId: CALL, role: 'caller', text: 'Can I book a cleaning?', atSec: 6.5 }), bearer(token()));
    expect(ev).toMatchObject({ type: 'transcript.partial', transcript: [{ role: 'caller', text: 'Can I book a cleaning?', atSec: 6.5 }] });
  });

  it('keeps optional transcript and analysis on call.ended when the worker sends them well-formed, and drops malformed ones', async () => {
    const good = await verifier()(envelope('call.ended', {
      callId: CALL, durationSec: 30, transcript: [{ role: 'agent', text: 'Hi', atSec: 0 }, { role: 'caller', text: 'Hello', atSec: 2 }],
      analysis: { summary: 'Booked a cleaning.', sentiment: 'positive' },
    }), bearer(token()));
    expect(good.transcript).toEqual([{ role: 'agent', text: 'Hi', atSec: 0 }, { role: 'caller', text: 'Hello', atSec: 2 }]);
    expect(good.analysis).toEqual({ summary: 'Booked a cleaning.', sentiment: 'positive' });

    const bad = await verifier()(envelope('call.ended', { callId: CALL, durationSec: 30, transcript: 'nope', analysis: { sentiment: 'furious' } }), bearer(token()));
    expect(bad.transcript).toBeUndefined();
    expect(bad.analysis?.sentiment).toBeUndefined();
  });

  it('finds the Authorization header however it is cased, and accepts a lowercase scheme', async () => {
    const body = envelope('call.started', { callId: CALL });
    await expect(verifier()(body, { Authorization: `Bearer ${token()}` })).resolves.toMatchObject({ type: 'call.started' });
    await expect(verifier()(body, { AUTHORIZATION: `bearer ${token()}` })).resolves.toMatchObject({ type: 'call.started' });
  });

  it('accepts a system service token that is not tied to one call', async () => {
    const t = mintTenantToken({ tid: TENANT, prn: 'system' }, SECRET, 600, NOW);
    await expect(verifier()(envelope('call.ended', { callId: 'other-call', durationSec: 5 }), bearer(t))).resolves.toMatchObject({ callId: 'other-call', tenantId: TENANT });
  });

  it('accepts a token signed with the previous secret during rotation', async () => {
    await expect(verifier()(envelope('call.started', { callId: CALL }), bearer(token({}, OLD_SECRET)))).resolves.toMatchObject({ tenantId: TENANT });
  });

  it('uses the tenant in the token even when the body names none', async () => {
    const body = JSON.stringify({ type: 'call.started', version: 1, correlationId: CALL, occurredAt: OCCURRED, data: { callId: CALL } });
    await expect(verifier()(body, bearer(token()))).resolves.toMatchObject({ tenantId: TENANT });
  });

  it('falls back to the clock when the event has no usable timestamp', async () => {
    const body = JSON.stringify({ type: 'call.started', version: 1, tenantId: TENANT, correlationId: CALL, data: { callId: CALL } });
    const ev = await verifier()(body, bearer(token()));
    expect(ev.occurredAt).toBe(new Date(NOW * 1000).toISOString());
  });

  describe('rejects', () => {
    const body = envelope('call.started', { callId: CALL });

    it('a request with no token', async () => {
      await expect(verifier()(body, {})).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('a header that is not a bearer token', async () => {
      await expect(verifier()(body, { authorization: `Basic ${token()}` })).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('garbage in place of a token', async () => {
      await expect(verifier()(body, bearer('not.a.token'))).rejects.toBeInstanceOf(WorkerEventAuthError);
      await expect(verifier()(body, bearer(''))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('a token signed with an unknown secret', async () => {
      await expect(verifier()(body, bearer(token({}, 'someone-elses-secret')))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('an expired token', async () => {
      await expect(verifier()(body, bearer(token({}, SECRET, 60, NOW - 120)))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it.each<Principal>(['admin-agent', 'owner', 'staff', 'ops'])('a %s token: only the call worker and system may post call events', async (prn) => {
      await expect(verifier()(body, bearer(token({ prn })))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('an event that names a different tenant than the token', async () => {
      const cross = JSON.stringify({ type: 'call.started', version: 1, tenantId: OTHER, correlationId: CALL, occurredAt: OCCURRED, data: { callId: CALL } });
      await expect(verifier()(cross, bearer(token()))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('a call-scoped token used for a different call', async () => {
      await expect(verifier()(envelope('call.started', { callId: 'someone-elses-call' }), bearer(token()))).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
    it('and never echoes the token in the error', async () => {
      const t = token({}, 'someone-elses-secret');
      const err = await verifier()(body, bearer(t)).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain(t);
      expect(String((err as Error).message)).not.toContain('someone-elses-secret');
    });
    it('does not read the body before the token checks out', async () => {
      await expect(verifier()('{ not json', { authorization: 'Bearer nope' })).rejects.toBeInstanceOf(WorkerEventAuthError);
    });
  });

  describe('malformed events from an authenticated worker', () => {
    it.each([
      ['not json', '{ nope'],
      ['not an object', '[]'],
      ['no data', JSON.stringify({ type: 'call.started' })],
      ['no call id', envelope('call.started', {})],
      ['call.ended without a duration', envelope('call.ended', { callId: CALL })],
      ['call.ended with a negative duration', envelope('call.ended', { callId: CALL, durationSec: -3 })],
      ['partial with an unknown role', envelope('transcript.partial', { callId: CALL, role: 'supervisor', text: 'x', atSec: 1 })],
      ['partial without text', envelope('transcript.partial', { callId: CALL, role: 'agent', atSec: 1 })],
    ])('%s is a WorkerEventError', async (_name, raw) => {
      await expect(verifier()(raw, bearer(token()))).rejects.toBeInstanceOf(WorkerEventError);
    });

    it('a type we do not map is acknowledged and dropped, not treated as a failure', async () => {
      const err = await verifier()(envelope('booking.created', { callId: CALL }), bearer(token())).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedEventError);
      expect(err).toMatchObject({ eventType: 'booking.created' });
    });
  });

  describe('LiveKit webhooks (signed by LiveKit, not by 1145)', () => {
    const lkBody = JSON.stringify({ event: 'room_finished', room: { name: 'call-room' }, id: 'EV_1', createdAt: '1800000000' });

    it('are verified with the WebhookReceiver, then acknowledged and dropped: the worker already reports its own calls', async () => {
      const hooks = fakeWebhooks({ event: 'room_finished' });
      const err = await verifier({ ports: { webhooks: hooks.port } })(lkBody, { authorization: 'eyJ.livekit.jwt' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedEventError);
      expect(err).toMatchObject({ eventType: 'room_finished' });
      expect(hooks.seen).toEqual([{ body: lkBody, auth: 'eyJ.livekit.jwt' }]);
    });

    it('with a bad LiveKit signature are rejected', async () => {
      const hooks = fakeWebhooks({ error: new Error('sha256 checksum of body does not match') });
      await expect(verifier({ ports: { webhooks: hooks.port } })(lkBody, { authorization: 'eyJ.forged.jwt' })).rejects.toBeInstanceOf(WorkerEventAuthError);
    });

    it('are rejected when no webhook verifier is configured', async () => {
      await expect(verifier()(lkBody, { authorization: 'eyJ.livekit.jwt' })).rejects.toBeInstanceOf(WorkerEventAuthError);
    });

    it('never reach LiveKit verification when a Bearer service token is present', async () => {
      const hooks = fakeWebhooks();
      await verifier({ ports: { webhooks: hooks.port } })(envelope('call.started', { callId: CALL }), bearer(token()));
      expect(hooks.seen).toEqual([]);
    });
  });
});
