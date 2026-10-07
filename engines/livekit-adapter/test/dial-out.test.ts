import { describe, expect, it } from 'vitest';
import { createLiveKitAdapterDeps, DialOutError, SMOKE_ROOM_PREFIX, type LiveKitAdapterConfig } from '../src/index.js';
import {
  CONNECTION_ID, NUMBER, NUMBER_2, OTHER, OWNER_PHONE, SECRET, TENANT, TRUNK_ID,
  fakeDispatch, fakePorts, fakeRoutes, fakeSip, fakeStores, fakeTelnyx, type Log,
} from './fakes.js';

const config: LiveKitAdapterConfig = {
  telnyxConnectionId: CONNECTION_ID, outboundTrunkId: TRUNK_ID, tokenSecrets: async () => [SECRET],
};
const ROOM = 'smoke-t_brightsmiles01-1800000000000-ab12cd34';

function build(opts: { sipError?: Error; createError?: Error; deleteError?: Error; reply?: { sipCallId: string }; seed?: Parameters<typeof fakeRoutes>[1]; cfg?: Partial<LiveKitAdapterConfig> } = {}) {
  const log: Log = [];
  const sip = fakeSip(log, { error: opts.sipError, reply: opts.reply });
  const dispatch = fakeDispatch(log, { createError: opts.createError, deleteError: opts.deleteError });
  const routes = fakeRoutes(log, opts.seed ?? { [NUMBER]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' } });
  const stores = fakeStores(log);
  const deps = createLiveKitAdapterDeps({ ...config, ...opts.cfg }, {
    sip: sip.port, dispatch: dispatch.port, telnyx: fakeTelnyx(log).port, routes: routes.port, config: stores.config, knowledge: stores.kb,
  });
  return { deps, log, sip, dispatch };
}

const params = { roomName: ROOM, to: OWNER_PHONE, fromNumber: NUMBER, tenantId: TENANT };

describe('dialOut: SipClient.createSipParticipant + AgentDispatch', () => {
  it('puts the frontdesk agent in the room first, then dials the owner on the outbound trunk from the tenant number', async () => {
    const t = build();
    const callId = await t.deps.dialOut(params);

    expect(t.log).toEqual(['dispatch.createDispatch', 'sip.createSipParticipant']);
    expect(t.dispatch.created).toEqual([{ room: ROOM, agentName: 'frontdesk', options: undefined }]);
    expect(t.sip.calls).toHaveLength(1);
    expect(t.sip.calls[0]).toMatchObject({ trunkId: TRUNK_ID, to: OWNER_PHONE, room: ROOM });
    expect(t.sip.calls[0]!.opts).toMatchObject({ fromNumber: NUMBER, waitUntilAnswered: true });
    expect(callId).toBe(ROOM);
  });

  it('uses the configured agent name, and bounds ringing and call length so a smoke call cannot run on', async () => {
    const t = build({ cfg: { agentName: 'frontdesk-dev', smokeCall: { ringingTimeoutSec: 20, maxCallSec: 90 } } });
    await t.deps.dialOut(params);
    expect(t.dispatch.created[0]!.agentName).toBe('frontdesk-dev');
    expect(t.sip.calls[0]!.opts).toMatchObject({ ringingTimeout: 20, maxCallDuration: 90 });
  });

  it('defaults to 30 s of ringing and a 120 s cap', async () => {
    const t = build();
    await t.deps.dialOut(params);
    expect(t.sip.calls[0]!.opts).toMatchObject({ ringingTimeout: 30, maxCallDuration: 120 });
  });

  // D8-3: smoke-call looks the result up by the id dialOut returns, so it must be the id call.ended carries. For a
  // `smoke-` room the worker (frontdesk/sip.py `call_id_for`) uses the room name, which both sides know before the
  // call connects. LiveKit's SIP call id is not used: nothing here confirms it equals the `sip.callID` attribute.
  it('returns the room name, which is the call id the worker puts on call.ended for a smoke room', async () => {
    for (const reply of [{ sipCallId: 'SCL_call_01' }, { sipCallId: '' }]) {
      const t = build({ reply });
      expect(await t.deps.dialOut(params)).toBe(ROOM);
    }
  });

  it('only dials into smoke- rooms, the ones whose call id the worker takes from the room name', async () => {
    expect(SMOKE_ROOM_PREFIX).toBe('smoke-');
    const t = build();
    await expect(t.deps.dialOut({ ...params, roomName: 'onboarding-room-1' })).rejects.toMatchObject({ reason: 'invalid_input' });
    expect(t.log).toEqual([]);
  });

  it('never puts the tenant id in the dispatch or the SIP call: the worker resolves it from the dialed number', async () => {
    const t = build();
    await t.deps.dialOut({ ...params, roomName: 'smoke-plain-room' });
    expect(JSON.stringify([t.dispatch.created, t.sip.calls])).not.toContain(TENANT);
  });

  it('refuses a from number that routes to another tenant, and dials and dispatches nothing', async () => {
    const t = build({ seed: { [NUMBER]: { tid: OTHER, state: 'active', engine: 'livekit-telnyx' } } });
    await expect(t.deps.dialOut(params)).rejects.toThrow(DialOutError);
    await expect(t.deps.dialOut(params)).rejects.toMatchObject({ reason: 'number_not_routed' });
    expect(t.log).toEqual([]);
  });

  it('refuses a from number with no route', async () => {
    const t = build();
    await expect(t.deps.dialOut({ ...params, fromNumber: NUMBER_2 })).rejects.toMatchObject({ reason: 'number_not_routed' });
    expect(t.log).toEqual([]);
  });

  it.each([
    ['to', { to: '2145550199' }],
    ['to', { to: '+0123456789' }],
    ['to', { to: 'sip:+12145550199@example.com' }],
    ['fromNumber', { fromNumber: '5125550100' }],
  ])('rejects a %s that is not E.164 before touching LiveKit', async (_field, bad) => {
    const t = build();
    await expect(t.deps.dialOut({ ...params, ...bad })).rejects.toMatchObject({ reason: 'invalid_input' });
    expect(t.log).toEqual([]);
  });

  it.each(['chat-t_brightsmiles01-abc', '', 'has space', 'a'.repeat(129), 'room/../x'])(
    'rejects room name %j (chat- rooms belong to the web widget path)', async (roomName) => {
      const t = build();
      await expect(t.deps.dialOut({ ...params, roomName })).rejects.toMatchObject({ reason: 'invalid_input' });
      expect(t.log).toEqual([]);
    });

  it('removes the dispatch and reports the SIP status when the owner does not pick up', async () => {
    const busy = Object.assign(new Error('SIP call failed: 486 Busy Here'), { sipStatusCode: 486, sipStatus: 'Busy Here' });
    const t = build({ sipError: busy });
    const err = await t.deps.dialOut(params).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DialOutError);
    expect(err).toMatchObject({ reason: 'dial_failed', sipStatusCode: 486 });
    expect(t.dispatch.deleted).toEqual([{ id: 'AD_dispatch_01', room: ROOM }]);
    expect(t.log).toEqual(['dispatch.createDispatch', 'sip.createSipParticipant', 'dispatch.deleteDispatch']);
  });

  it('still reports the dial failure when cleaning up the dispatch fails too', async () => {
    const t = build({ sipError: new Error('twirp unavailable'), deleteError: new Error('also down') });
    await expect(t.deps.dialOut(params)).rejects.toMatchObject({ reason: 'dial_failed', message: expect.stringContaining('twirp unavailable') });
  });

  it('does not dial when the agent cannot be dispatched', async () => {
    const t = build({ createError: new Error('dispatch unavailable') });
    await expect(t.deps.dialOut(params)).rejects.toMatchObject({ reason: 'dispatch_failed' });
    expect(t.log).toEqual(['dispatch.createDispatch']);
  });
});
