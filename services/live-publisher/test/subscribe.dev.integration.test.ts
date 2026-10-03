import { describe, expect, it } from 'vitest';

/**
 * FOLLOW-UP (needs a deployed dev stack): owner A cannot subscribe to /tenants/<B>/live or /owners/<other>/chat.
 * Skipped unless all of these are set (never commit values): EVENTS_REALTIME_DOMAIN (the API's realtime DNS),
 * OWNER_A_JWT, OWNER_A_TENANT_ID, OWNER_A_SUB, TENANT_B_ID, OWNER_B_SUB. Tokens come from a dev Cognito test user.
 * Protocol: AppSync Events WebSocket (connection_init, subscribe, subscribe_success / subscribe_error).
 */
const E = process.env;
const ready = Boolean(E.EVENTS_REALTIME_DOMAIN && E.OWNER_A_JWT && E.OWNER_A_TENANT_ID && E.OWNER_A_SUB && E.TENANT_B_ID && E.OWNER_B_SUB);

function subscribeOutcome(channel: string): Promise<'subscribed' | 'denied'> {
  const realtimeHost = E.EVENTS_REALTIME_DOMAIN!.replace(/^wss?:\/\//, '').split('/')[0]!;
  const httpHost = realtimeHost.replace('appsync-realtime-api', 'appsync-api');
  const auth = { host: httpHost, Authorization: E.OWNER_A_JWT! };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${realtimeHost}/event/realtime`, ['aws-appsync-event-ws', `header-${b64(auth)}`]);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string };
      if (msg.type === 'connection_ack') ws.send(JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel, authorization: auth }));
      if (msg.type === 'subscribe_success') { clearTimeout(timer); ws.close(); resolve('subscribed'); }
      if (msg.type === 'subscribe_error') { clearTimeout(timer); ws.close(); resolve('denied'); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

describe.skipIf(!ready)('dev: channel authorization', () => {
  it('owner A can subscribe to their own tenant live channel and own chat', async () => {
    expect(await subscribeOutcome(`/tenants/${E.OWNER_A_TENANT_ID}/live`)).toBe('subscribed');
    expect(await subscribeOutcome(`/owners/${E.OWNER_A_SUB}/chat`)).toBe('subscribed');
  });
  it('owner A cannot subscribe to /tenants/<B>/live', async () => {
    expect(await subscribeOutcome(`/tenants/${E.TENANT_B_ID}/live`)).toBe('denied');
  });
  it('owner A cannot subscribe to owner B chat or the ops fleet channel', async () => {
    expect(await subscribeOutcome(`/owners/${E.OWNER_B_SUB}/chat`)).toBe('denied');
    expect(await subscribeOutcome('/ops/fleet')).toBe('denied');
  });
});

describe.skipIf(ready)('dev: channel authorization (needs deployed dev stack)', () => {
  it.skip('follow-up: set the env listed in the file header to run against dev', () => {});
});
