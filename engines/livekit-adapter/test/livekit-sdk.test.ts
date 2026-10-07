import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDispatchClient, SipClient, WebhookReceiver } from 'livekit-server-sdk';
import { createLiveKitClients, createLiveKitEngine, type AgentDispatcher, type SipDialer, type WebhookVerifier } from '../src/index.js';
import {
  CONNECTION_ID, NUMBER, OWNER_PHONE, SECRET, TENANT, TRUNK_ID, fakePorts,
} from './fakes.js';

/**
 * The adapter codes against small ports; this file proves the real livekit-server-sdk classes fit them (at compile
 * time) and that the requests they put on the wire are the LiveKit Twirp calls we mean. fetch is stubbed: no network.
 */
const URL_ = 'wss://frontdesk.example.test';
const KEY = 'APItestkey';
const API_SECRET = 'livekit-api-secret-for-tests-only-0123456789';
const ROOM = `smoke-${TENANT}-1800000000000-ab12cd34`;

interface Wire { path: string; body: Record<string, unknown>; auth: string }
let wire: Wire[] = [];

beforeEach(() => {
  wire = [];
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    wire.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown>, auth: String((init.headers as Record<string, string>).Authorization) });
    const reply = path.endsWith('/CreateDispatch') ? { id: 'AD_01', agentName: 'frontdesk', room: ROOM }
      : path.endsWith('/CreateSIPParticipant') ? { participantId: 'PA_01', participantIdentity: 'sip-participant', roomName: ROOM, sipCallId: 'SCL_real_01' }
      : {};
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the real livekit-server-sdk fits the adapter ports', () => {
  it('SipClient, AgentDispatchClient and WebhookReceiver are assignable to the ports', () => {
    const c = createLiveKitClients({ url: URL_, apiKey: KEY, apiSecret: API_SECRET });
    expect(c.sip).toBeInstanceOf(SipClient);
    expect(c.dispatch).toBeInstanceOf(AgentDispatchClient);
    expect(c.webhooks).toBeInstanceOf(WebhookReceiver);
    // Compile-time checks: if the SDK changes a signature these lines stop type-checking.
    const sip: SipDialer = new SipClient(URL_, KEY, API_SECRET);
    const dispatch: AgentDispatcher = new AgentDispatchClient(URL_, KEY, API_SECRET);
    const hooks: WebhookVerifier = new WebhookReceiver(KEY, API_SECRET);
    expect([sip, dispatch, hooks]).toHaveLength(3);
  });

  it.each([
    ['url', { url: '' }], ['url scheme', { url: 'ftp://x.test' }], ['apiKey', { apiKey: '' }], ['apiSecret', { apiSecret: ' ' }],
  ])('rejects a bad %s without echoing the secret', (_n, bad) => {
    const attempt = () => createLiveKitClients({ url: URL_, apiKey: KEY, apiSecret: API_SECRET, ...bad });
    expect(attempt).toThrow();
    try { attempt(); } catch (e) { expect(String((e as Error).message)).not.toContain(API_SECRET); }
  });

  it('placeSmokeTestCall sends CreateDispatch for the room, then CreateSIPParticipant on the outbound trunk', async () => {
    const t = fakePorts();
    const real = createLiveKitClients({ url: URL_, apiKey: KEY, apiSecret: API_SECRET });
    const engine = createLiveKitEngine(
      { telnyxConnectionId: CONNECTION_ID, outboundTrunkId: TRUNK_ID, tokenSecrets: async () => [SECRET], now: () => new Date(1_800_000_000_000), newId: () => 'ab12cd34' },
      { ...t.ports, sip: real.sip, dispatch: real.dispatch },
    );

    const { callId } = await engine.placeSmokeTestCall({ engine: 'livekit-telnyx', tenantId: TENANT, agentId: `frontdesk:${TENANT}` }, NUMBER, OWNER_PHONE);

    expect(callId).toBe('SCL_real_01');
    expect(wire.map((w) => w.path)).toEqual(['/twirp/livekit.AgentDispatchService/CreateDispatch', '/twirp/livekit.SIP/CreateSIPParticipant']);
    expect(wire[0]!.body).toMatchObject({ room: ROOM, agentName: 'frontdesk' });
    expect(wire[0]!.body).not.toHaveProperty('metadata');
    expect(wire[1]!.body).toMatchObject({
      sipTrunkId: TRUNK_ID, sipCallTo: OWNER_PHONE, sipNumber: NUMBER, roomName: ROOM, waitUntilAnswered: true,
    });
    expect(wire[1]!.body.ringingTimeout).toBe('30s');
    expect(wire[1]!.body.maxCallDuration).toBe('120s');
    for (const w of wire) {
      expect(w.auth).toMatch(/^Bearer ey/);
      expect(JSON.stringify(w.body)).not.toContain(API_SECRET);
    }
  });

  it('the dispatch grant is for the smoke room only, and the SIP call uses a call grant', async () => {
    const real = createLiveKitClients({ url: URL_, apiKey: KEY, apiSecret: API_SECRET });
    await real.dispatch.createDispatch(ROOM, 'frontdesk');
    await real.sip.createSipParticipant(TRUNK_ID, OWNER_PHONE, ROOM, { fromNumber: NUMBER });
    const claims = wire.map((w) => JSON.parse(Buffer.from(w.auth.replace('Bearer ', '').split('.')[1]!, 'base64url').toString('utf8')) as Record<string, any>);
    expect(claims[0]!.video).toMatchObject({ roomAdmin: true, room: ROOM });
    expect(claims[1]!.sip).toMatchObject({ call: true });
  });
});
