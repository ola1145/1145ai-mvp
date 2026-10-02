import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256(secret: string | Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
