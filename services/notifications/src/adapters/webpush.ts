import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { Outcome, PushPayload, PushSubscriptionRecord } from '../types.js';
import { sendWithRetry, timeoutSignal, type AdapterBase } from './http.js';

/**
 * Web push with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), on node:crypto only.
 * (The `web-push` package is CommonJS and does not bundle into the ESM Lambda; this is ~60 lines and tested
 * round-trip. No Apple/Google developer program is involved: browsers hand out the subscription endpoint.)
 */
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
const RECORD_SIZE = 4096;

export interface EncryptInput {
  payload: Buffer;
  /** The browser's p256dh key, 65 bytes uncompressed. */
  uaPublic: Buffer;
  /** The browser's 16-byte auth secret. */
  authSecret: Buffer;
  /** Test hooks. Real sends use a fresh salt and key pair every time. */
  salt?: Buffer;
  asPrivate?: Buffer;
}

export function encryptPayload(i: EncryptInput): Buffer {
  if (i.payload.length > RECORD_SIZE - 103) throw new Error('push payload too large');
  const as = createECDH('prime256v1');
  if (i.asPrivate) as.setPrivateKey(i.asPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const secret = as.computeSecret(i.uaPublic);
  const ikm = hkdf(secret, i.authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), i.uaPublic, asPublic]), 32);
  const salt = i.salt ?? randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([i.payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

export function vapidHeaders(i: { endpoint: string; subject: string; publicKey: string; privateKey: string; now?: Date }): string {
  const pub = Buffer.from(i.publicKey, 'base64url');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: i.privateKey },
    format: 'jwk',
  });
  const exp = Math.floor((i.now ?? new Date()).getTime() / 1000) + 12 * 3600;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(i.endpoint).origin, exp, sub: i.subject })));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${i.publicKey}`;
}

export type PushSender = (sub: PushSubscriptionRecord, payload: PushPayload, opts: { urgent: boolean }) => Promise<Outcome>;

export function createPushSender(o: AdapterBase & { subject: string; publicKey: string; privateKey: string; now?: () => Date }): PushSender {
  const f = o.fetch ?? fetch;
  return async (sub, payload, { urgent }) => {
    let url: URL;
    let uaPublic: Buffer;
    let authSecret: Buffer;
    try {
      url = new URL(sub.endpoint);
      uaPublic = Buffer.from(sub.p256dh, 'base64url');
      authSecret = Buffer.from(sub.auth, 'base64url');
    } catch {
      return { status: 'rejected', attempts: 0, detail: 'malformed subscription' };
    }
    // Endpoints come from browsers via the owner app; never let one point at an internal address.
    if (url.protocol !== 'https:') return { status: 'rejected', attempts: 0, detail: 'push endpoint must be https' };
    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) return { status: 'rejected', attempts: 0, detail: 'malformed subscription keys' };

    const body = encryptPayload({ payload: Buffer.from(JSON.stringify(payload)), uaPublic, authSecret });
    const authorization = vapidHeaders({ endpoint: sub.endpoint, subject: o.subject, publicKey: o.publicKey, privateKey: o.privateKey, ...(o.now ? { now: o.now() } : {}) });
    return sendWithRetry(
      o,
      () => f(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: urgent ? 'high' : 'normal',
        },
        body: new Uint8Array(body),
        signal: timeoutSignal(o.timeoutMs),
      }),
      { gone: [404, 410], secrets: [o.privateKey] },
    );
  };
}
