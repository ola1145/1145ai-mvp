/** Small retry helper shared by the adapters. Time and the network are injected so tests never wait or call out. */
export type Attempt<T> = { done: T } | { retry: string; afterMs?: number };
export type RetryResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number };

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Backoff is baseMs, then baseMs * 3, then * 9: short, so a booking still reaches the owner within seconds. */
export async function withRetry<T>(op: () => Promise<Attempt<T>>, opts: RetryOpts = {}): Promise<RetryResult<T>> {
  const max = opts.attempts ?? 3;
  const base = opts.baseMs ?? 250;
  const sleep = opts.sleep ?? realSleep;
  let lastError = 'unknown error';
  for (let i = 1; i <= max; i++) {
    let step: Attempt<T>;
    try {
      step = await op();
    } catch (e) {
      step = { retry: e instanceof Error ? e.message : 'request failed' };
    }
    if ('done' in step) return { ok: true, value: step.done, attempts: i };
    lastError = step.retry;
    if (i < max) await sleep(step.afterMs ?? base * 3 ** (i - 1));
  }
  return { ok: false, error: lastError, attempts: max };
}

/** Cap a server-provided wait so a bad Retry-After cannot stall the Lambda. */
export function waitFromHeader(value: string | null | undefined, capMs = 5000): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (!Number.isFinite(s) || s < 0) return undefined;
  return Math.min(s * 1000, capMs);
}

/** Shared HTTP classification: 429/5xx retry, 2xx done, everything else is final. */
export type HttpClass = 'ok' | 'retry' | 'rejected';
export const classifyStatus = (status: number): HttpClass => (status >= 200 && status < 300 ? 'ok' : status === 429 || status >= 500 ? 'retry' : 'rejected');
