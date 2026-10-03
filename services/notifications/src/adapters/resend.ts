import type { Outcome } from '../types.js';
import { sendWithRetry, timeoutSignal, type AdapterBase } from './http.js';

export interface EmailMessage { to: string; subject: string; text: string; idempotencyKey: string }
export type EmailSender = (m: EmailMessage) => Promise<Outcome>;

/** Resend REST API. Plain text, one recipient per message, idempotency key so a retry cannot double-send. */
export function createResendSender(o: AdapterBase & { apiKey: string; from: string }): EmailSender {
  const f = o.fetch ?? fetch;
  return (m) =>
    sendWithRetry(
      o,
      () => f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
        // A subject with a line break is a header-injection attempt; flatten it.
        body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject.replace(/[\r\n]+/g, ' ').trim(), text: m.text }),
        signal: timeoutSignal(o.timeoutMs),
      }),
      { secrets: [o.apiKey] },
    );
}
