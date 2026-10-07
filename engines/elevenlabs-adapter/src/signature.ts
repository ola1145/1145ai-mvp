import { hmacSha256 } from '@1145/shared';
import { timingSafeEqual } from 'node:crypto';

/**
 * How old a webhook's timestamp may be (SEC-30). A captured delivery is only replayable inside this window, and
 * `ElevenAgentsEngine` also refuses a second delivery of the same conversation. Five minutes covers clock skew and
 * the provider's own retries.
 */
export const SIGNATURE_TOLERANCE_SEC = 300;
/** A timestamp this far ahead of our clock is rejected too (clock skew allowance). */
const FUTURE_SKEW_SEC = 60;

/** ElevenLabs post-call webhook header "ElevenLabs-Signature: t=<unix>,v0=<hex(HMAC_SHA256(secret, `${t}.${body}`))>". */
export function verifyElevenLabsSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = SIGNATURE_TOLERANCE_SEC, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const kv = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(kv.t);
  if (!Number.isFinite(t) || nowSec - t > toleranceSec || t - nowSec > FUTURE_SKEW_SEC) return false;
  const given = Buffer.from(kv.v0 ?? '', 'hex');
  const expected = hmacSha256(secret, `${t}.${rawBody}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
