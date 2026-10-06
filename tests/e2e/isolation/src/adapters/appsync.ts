import type { RealtimePort, RealtimeResult } from '../types.js';

export interface AppSyncConfig { httpHost: string; realtimeHost: string; timeoutMs?: number }

const DENIED = /unauthorized|forbidden|access.?denied|not authorized/i;
const b64u = (s: string) => Buffer.from(s).toString('base64url');

/**
 * Real adapter for AppSync Events (Cognito user pool auth: the JWT goes in the Authorization header).
 * Only an explicit authorization refusal is reported as `{ ok: false }`. Timeouts, transport errors and
 * malformed-request errors THROW, so they surface as failures instead of looking like a successful denial.
 * NOTE: wire format follows the AppSync Events docs and has not yet been exercised against the dev API.
 */
export function appSyncPort(cfg: AppSyncConfig): RealtimePort {
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  return {
    subscribe(jwt, channel) {
      const auth = { host: cfg.httpHost, Authorization: jwt };
      return new Promise<RealtimeResult>((resolve, reject) => {
        const ws = new WebSocket(`wss://${cfg.realtimeHost}/event/realtime`, ['aws-appsync-event-ws', `header-${b64u(JSON.stringify(auth))}`]);
        const done = (fn: () => void) => { clearTimeout(timer); try { ws.close(); } catch { /* already closed */ } fn(); };
        const timer = setTimeout(() => done(() => reject(new Error(`subscribe ${channel}: timed out after ${timeoutMs} ms`))), timeoutMs);
        const id = crypto.randomUUID();
        ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
        ws.addEventListener('error', () => done(() => reject(new Error(`subscribe ${channel}: websocket error`))));
        ws.addEventListener('close', () => done(() => reject(new Error(`subscribe ${channel}: socket closed before an answer`))));
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(String(ev.data)) as { type: string; errors?: Array<{ errorType?: string; message?: string }> };
          if (m.type === 'connection_ack') ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: auth }));
          else if (m.type === 'subscribe_success') done(() => resolve({ ok: true }));
          else if (m.type === 'subscribe_error' || m.type === 'connection_error' || m.type === 'error') {
            const text = JSON.stringify(m.errors ?? m);
            done(() => (DENIED.test(text) ? resolve({ ok: false, error: text }) : reject(new Error(`subscribe ${channel}: unexpected ${m.type} ${text}`))));
          }
        });
      });
    },

    async publish(jwt, channel, event) {
      const res = await fetch(`https://${cfg.httpHost}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: jwt },
        body: JSON.stringify({ channel, events: [JSON.stringify(event)] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) return { ok: false, error: `HTTP ${res.status}` };
      if (!res.ok) throw new Error(`publish ${channel}: unexpected HTTP ${res.status} ${text.slice(0, 200)}`);
      let j: { successful?: unknown[]; failed?: unknown[] } = {};
      try { j = JSON.parse(text) as typeof j; } catch { /* leave empty */ }
      if ((j.successful ?? []).length > 0) return { ok: true };
      if (DENIED.test(text)) return { ok: false, error: text.slice(0, 200) };
      throw new Error(`publish ${channel}: HTTP 200 but no accepted event and no authorization error: ${text.slice(0, 200)}`);
    },
  };
}
