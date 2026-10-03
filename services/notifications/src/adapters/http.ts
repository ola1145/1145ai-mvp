import { classifyStatus, waitFromHeader, withRetry, type Attempt, type RetryOpts } from '../retry.js';
import type { Outcome } from '../types.js';

export interface AdapterBase extends RetryOpts {
  fetch?: typeof fetch;
  /** Per-request timeout. The whole dispatcher has to stay well inside the Lambda timeout. */
  timeoutMs?: number;
}

export interface HttpResult { status: number; retryAfterMs?: number; body?: unknown }

/** Hide a secret that might show up in an error message or URL. */
export const redact = (text: string, ...secrets: Array<string | undefined>): string =>
  secrets.reduce<string>((t, s) => (s ? t.split(s).join('***') : t), text).slice(0, 300);

/**
 * Run one request with retries and map the result to an Outcome.
 * 2xx = sent; 429/5xx/network = retry; any other status = rejected (final, do not redeliver).
 * `extraWait` lets an adapter read a service-specific wait (Telegram puts it in the body).
 */
export async function sendWithRetry(
  base: AdapterBase,
  request: () => Promise<Response>,
  opts: { gone?: number[]; secrets?: Array<string | undefined>; extraWait?: (body: unknown) => number | undefined } = {},
): Promise<Outcome> {
  const secrets = opts.secrets ?? [];
  const r = await withRetry<Outcome>(async (): Promise<Attempt<Outcome>> => {
    const res = await request();
    const kind = classifyStatus(res.status);
    if (kind === 'ok') return { done: { status: 'sent', attempts: 0 } };
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    if (opts.gone?.includes(res.status)) return { done: { status: 'gone', attempts: 0, detail: `http ${res.status}` } };
    if (kind === 'retry') {
      const afterMs = opts.extraWait?.(body) ?? waitFromHeader(res.headers.get('retry-after'));
      return { retry: `http ${res.status}`, ...(afterMs !== undefined ? { afterMs } : {}) };
    }
    const hint = body && typeof body === 'object' ? JSON.stringify(body) : '';
    return { done: { status: 'rejected', attempts: 0, detail: redact(`http ${res.status} ${hint}`, ...secrets) } };
  }, base);
  if (r.ok) return { ...r.value, attempts: r.attempts };
  return { status: 'failed', attempts: r.attempts, detail: redact(r.error, ...secrets) };
}

export const timeoutSignal = (ms = 4000): AbortSignal => AbortSignal.timeout(ms);
