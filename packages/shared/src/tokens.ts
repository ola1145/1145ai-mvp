import { hmacSha256 } from './crypto.js';
import { timingSafeEqual } from 'node:crypto';
import type { Principal } from './tenant-context.js';

/**
 * Compact HS256 JWS used between 1145 services (resolver -> voice worker -> tool API, router -> agents -> tool API).
 * The model never sees these tokens. Secrets come from Secrets Manager and support rotation (try each key).
 */
export interface TenantTokenClaims {
  tid: string;            // tenant id
  prn: Principal;         // principal
  cid?: string;           // correlation / call id
  clr?: string;           // caller E.164 from carrier signalling (voice only)
  ch?: string;            // channel
  aud: 'tool-api';
  iat: number;
  exp: number;
}

export class TokenError extends Error {}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function mintTenantToken(
  claims: Omit<TenantTokenClaims, 'aud' | 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 900,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({ ...claims, aud: 'tool-api', iat: nowSeconds, exp: nowSeconds + ttlSeconds });
  const sig = hmacSha256(secret, `${header}.${payload}`).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyTenantToken(
  token: string,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): TenantTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token');
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string };
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { throw new TokenError('bad header'); }
  if (header.alg !== 'HS256') throw new TokenError('unsupported alg');

  const given = Buffer.from(s, 'base64url');
  const ok = secrets.some((secret) => {
    const expected = hmacSha256(secret, `${h}.${p}`);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!ok) throw new TokenError('bad signature');

  let claims: TenantTokenClaims;
  try { claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw new TokenError('bad payload'); }
  if (claims.aud !== 'tool-api') throw new TokenError('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new TokenError('expired');
  if (!claims.tid || !claims.prn) throw new TokenError('missing claims');
  return claims;
}
