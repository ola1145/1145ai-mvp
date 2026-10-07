import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { SIGNATURE_TOLERANCE_SEC, verifyElevenLabsSignature } from '../src/signature.js';

describe('ElevenLabs webhook signature', () => {
  const secret = 'wsec';
  const body = '{"type":"post_call_transcription"}';
  const now = 1_800_000_000;
  const header = (t: number) => `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  it('accepts a valid signature', () => expect(verifyElevenLabsSignature(body, header(now - 5), secret, 1800, now)).toBe(true));
  it('rejects a stale signature', () => expect(verifyElevenLabsSignature(body, header(now - 4000), secret, 1800, now)).toBe(false));
  it('rejects a modified body', () => expect(verifyElevenLabsSignature(body + ' ', header(now), secret, 1800, now)).toBe(false));

  // SEC-30: a captured webhook could be replayed for half an hour. Five minutes is plenty for clock skew and retries.
  it('allows five minutes by default, not thirty', () => {
    expect(SIGNATURE_TOLERANCE_SEC).toBe(300);
    expect(verifyElevenLabsSignature(body, header(now - 299), secret, undefined, now)).toBe(true);
    expect(verifyElevenLabsSignature(body, header(now - 301), secret, undefined, now)).toBe(false);
    expect(verifyElevenLabsSignature(body, header(now - 1500), secret, undefined, now)).toBe(false);
  });
  it('rejects a timestamp from the future beyond a minute of skew', () => {
    expect(verifyElevenLabsSignature(body, header(now + 30), secret, undefined, now)).toBe(true);
    expect(verifyElevenLabsSignature(body, header(now + 120), secret, undefined, now)).toBe(false);
  });
  it('rejects malformed headers without throwing', () => {
    for (const h of [undefined, '', 'garbage', 't=abc,v0=00', `t=${now}`, `t=${now},v0=zz`]) {
      expect(verifyElevenLabsSignature(body, h, secret, undefined, now)).toBe(false);
    }
  });
});
