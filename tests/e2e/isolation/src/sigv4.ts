/** Minimal AWS Signature V4 (no SDK dependency: tests/e2e adds none). Enough for STS and DynamoDB JSON calls. */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCreds { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface SignInput {
  method: string;
  url: string;
  service: string;
  region: string;
  headers: Record<string, string>;
  body: string;
  creds: AwsCreds;
  now?: Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Returns the headers to send: everything passed in, plus x-amz-date, authorization and (if any) the session token. */
export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const amzDate = (i.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);

  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) toSign[k.toLowerCase()] = v.trim();
  toSign.host = u.host;
  toSign['x-amz-date'] = amzDate;
  if (i.creds.sessionToken) toSign['x-amz-security-token'] = i.creds.sessionToken;

  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [i.method.toUpperCase(), u.pathname || '/', query, canonicalHeaders, signedHeaders, sha256(i.body)].join('\n');

  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.creds.secretAccessKey}`, day), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  const out: Record<string, string> = { ...i.headers, 'x-amz-date': amzDate };
  if (i.creds.sessionToken) out['x-amz-security-token'] = i.creds.sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
