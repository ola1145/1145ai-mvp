import type { Outcome } from '../types.js';
import { sendWithRetry, timeoutSignal, type AdapterBase } from './http.js';

export interface CallRequest { to: string; spoken: string; idempotencyKey: string }
export type CallPlacer = (c: CallRequest) => Promise<Outcome>;

const E164 = /^\+[1-9]\d{6,14}$/;
const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Outbound call to the owner for an urgent handoff, using a Telnyx TeXML application. It speaks one short line.
 * The dispatcher only calls this for an urgent handoff.requested (see routing.planDelivery); there is no SMS fallback.
 */
export function createCallPlacer(o: AdapterBase & { apiKey: string; applicationId: string; from: string }): CallPlacer {
  const f = o.fetch ?? fetch;
  return async (c) => {
    if (!E164.test(c.to)) return { status: 'rejected', attempts: 0, detail: 'owner phone is not a valid number' };
    const texml = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say>${xmlEscape(c.spoken)}</Say></Response>`;
    return sendWithRetry(
      o,
      () => f(`https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(o.applicationId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ To: c.to, From: o.from, Texml: texml }),
        signal: timeoutSignal(o.timeoutMs),
      }),
      { secrets: [o.apiKey] },
    );
  };
}
