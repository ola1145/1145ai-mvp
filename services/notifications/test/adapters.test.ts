import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/retry.js';
import { createTelegramSender } from '../src/adapters/telegram.js';
import { createResendSender } from '../src/adapters/resend.js';
import { createPushSender, encryptPayload, vapidHeaders } from '../src/adapters/webpush.js';
import { createCallPlacer } from '../src/adapters/telnyx-call.js';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A scripted fetch: each call takes the next response (or throws if given an Error). */
function scripted(...steps: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps.shift() ?? json(500);
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fetchFn, calls };
}
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const headerOf = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

describe('withRetry', () => {
  it('backs off exponentially and gives up after the attempt budget', async () => {
    sleeps.length = 0;
    let n = 0;
    const r = await withRetry(async () => { n++; return { retry: 'nope' }; }, { attempts: 3, baseMs: 100, sleep });
    expect(r).toEqual({ ok: false, error: 'nope', attempts: 3 });
    expect(n).toBe(3);
    expect(sleeps).toEqual([100, 300]);
  });
  it('honours a server-provided wait', async () => {
    sleeps.length = 0;
    let n = 0;
    const r = await withRetry(async () => (++n === 1 ? { retry: 'slow down', afterMs: 1500 } : { done: 'ok' }), { baseMs: 100, sleep });
    expect(r).toEqual({ ok: true, value: 'ok', attempts: 2 });
    expect(sleeps).toEqual([1500]);
  });
  it('treats a thrown error as retryable', async () => {
    let n = 0;
    const r = await withRetry(async () => { if (++n < 2) throw new Error('socket hang up'); return { done: 1 }; }, { baseMs: 1, sleep });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });
});

describe('telegram adapter', () => {
  const make = (...steps: Array<Response | Error>) => {
    const f = scripted(...steps);
    return { ...f, send: createTelegramSender({ token: 'TKN', fetch: f.fetchFn, sleep }) };
  };

  it('posts plain text to sendMessage, silently when asked', async () => {
    const { send, calls } = make(json(200, { ok: true }));
    expect(await send('42', 'New booking: Tunde, haircut, tomorrow at 3.', { silent: true })).toMatchObject({ status: 'sent', attempts: 1 });
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTKN/sendMessage');
    expect(bodyOf(calls[0]!)).toMatchObject({ chat_id: '42', text: 'New booking: Tunde, haircut, tomorrow at 3.', disable_notification: true });
    expect(bodyOf(calls[0]!).parse_mode).toBeUndefined();
  });
  it('retries 5xx and network errors, then succeeds', async () => {
    const { send, calls } = make(json(502), new Error('ECONNRESET'), json(200, { ok: true }));
    expect(await send('42', 'hi', { silent: false })).toMatchObject({ status: 'sent', attempts: 3 });
    expect(calls).toHaveLength(3);
  });
  it('waits out Telegram 429 retry_after', async () => {
    sleeps.length = 0;
    const { send } = make(json(429, { ok: false, parameters: { retry_after: 2 } }), json(200, { ok: true }));
    expect(await send('42', 'hi', { silent: false })).toMatchObject({ status: 'sent', attempts: 2 });
    expect(sleeps).toEqual([2000]);
  });
  it('does not retry when the owner blocked the bot', async () => {
    const { send, calls } = make(json(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }));
    expect(await send('42', 'hi', { silent: false })).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(1);
  });
  it('reports failed after exhausting retries, and never leaks the token in the detail', async () => {
    const { send } = make(json(500), json(500), json(500));
    const r = await send('42', 'hi', { silent: false });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).not.toContain('TKN');
  });
});

describe('resend email adapter', () => {
  const make = (...steps: Array<Response | Error>) => {
    const f = scripted(...steps);
    return { ...f, send: createResendSender({ apiKey: 'KEY', from: 'Front desk <hello@mail.1145.ai>', fetch: f.fetchFn, sleep }) };
  };
  const msg = { to: 'kemi@example.com', subject: 'New booking: Tunde, haircut, tomorrow at 3', text: 'New booking: Tunde, haircut, tomorrow at 3.', idempotencyKey: 'evt1-kemi' };

  it('sends plain text with an idempotency key so a retry cannot double-send', async () => {
    const { send, calls } = make(json(200, { id: 'e1' }));
    expect(await send(msg)).toMatchObject({ status: 'sent' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer KEY');
    expect(headerOf(calls[0]!, 'Idempotency-Key')).toBe('evt1-kemi');
    expect(bodyOf(calls[0]!)).toEqual({ from: 'Front desk <hello@mail.1145.ai>', to: ['kemi@example.com'], subject: msg.subject, text: msg.text });
  });
  it('retries 429 and 5xx with backoff', async () => {
    const { send, calls } = make(json(429, {}, { 'retry-after': '1' }), json(503), json(200, { id: 'e1' }));
    expect(await send(msg)).toMatchObject({ status: 'sent', attempts: 3 });
    expect(calls).toHaveLength(3);
  });
  it('does not retry a rejected address', async () => {
    const { send, calls } = make(json(422, { message: 'Invalid `to` field' }));
    expect(await send(msg)).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(1);
  });
  it('strips line breaks out of the subject', async () => {
    const { send, calls } = make(json(200, {}));
    await send({ ...msg, subject: 'Hi\r\nBcc: someone@evil.example' });
    expect(bodyOf(calls[0]!).subject).toBe('Hi Bcc: someone@evil.example');
  });
});

describe('web push (VAPID, RFC 8291 aes128gcm)', () => {
  const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
  const fromB64u = (s: string) => Buffer.from(s, 'base64url');

  it('produces the same bytes as http_ece (the reference implementation inside the web-push package)', () => {
    const require = createRequire(createRequire(import.meta.url).resolve('web-push/package.json'));
    const ece = require('http_ece') as { encrypt: (p: Buffer, o: Record<string, unknown>) => Buffer };
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const mine = createECDH('prime256v1'); mine.generateKeys();
    const salt = Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex');
    const auth = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const payload = Buffer.from('When I grow up, I want to be a watermelon');
    const expected = ece.encrypt(payload, { version: 'aes128gcm', dh: b64u(ua.getPublicKey()), privateKey: mine, salt: b64u(salt), authSecret: b64u(auth) });
    const got = encryptPayload({ payload, uaPublic: ua.getPublicKey(), authSecret: auth, salt, asPrivate: mine.getPrivateKey() });
    expect(b64u(got)).toBe(b64u(expected));
  });

  it('round-trips for a fresh subscription', () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const body = encryptPayload({ payload: Buffer.from('{"title":"New booking"}'), uaPublic: ua.getPublicKey(), authSecret: auth });
    // decrypt as the browser would
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const secret = ua.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    expect(plain.subarray(0, plain.length - 1).toString()).toBe('{"title":"New booking"}');
    expect(plain[plain.length - 1]).toBe(2);
  });

  const vapidKeys = (() => {
    const e = createECDH('prime256v1'); e.generateKeys();
    return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
  })();

  it('signs a VAPID JWT the push service can verify', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const h = vapidHeaders({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', subject: 'mailto:hello@1145.ai', ...vapidKeys, now });
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe(vapidKeys.publicKey);
    const [head, claims, sig] = token!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: 'mailto:hello@1145.ai' });
    const pub = fromB64u(vapidKeys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
    const ok = createVerify('SHA256').update(`${head}.${claims}`).verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
    expect(ok).toBe(true);
  });

  const ua = (() => { const e = createECDH('prime256v1'); e.generateKeys(); return e; })();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.from('0123456789abcdef')) };
  const make = (...steps: Array<Response | Error>) => {
    const f = scripted(...steps);
    return { ...f, send: createPushSender({ subject: 'mailto:hello@1145.ai', ...vapidKeys, fetch: f.fetchFn, sleep }) };
  };
  const payload = { title: 'New booking', body: 'New booking: Tunde, haircut, tomorrow at 3.', tag: 'evt1' };

  it('posts an encrypted body with VAPID headers', async () => {
    const { send, calls } = make(new Response(null, { status: 201 }));
    expect(await send(sub, payload, { urgent: false })).toMatchObject({ status: 'sent' });
    expect(calls[0]!.url).toBe(sub.endpoint);
    expect(headerOf(calls[0]!, 'Content-Encoding')).toBe('aes128gcm');
    expect(headerOf(calls[0]!, 'Authorization')).toMatch(/^vapid t=.+, k=.+$/);
    expect(headerOf(calls[0]!, 'TTL')).toBe('86400');
    expect(headerOf(calls[0]!, 'Urgency')).toBe('normal');
    expect(Buffer.from(calls[0]!.init.body as Uint8Array).includes(Buffer.from('Tunde'))).toBe(false); // encrypted
  });
  it('marks urgent pushes high urgency', async () => {
    const { send, calls } = make(new Response(null, { status: 201 }));
    await send(sub, payload, { urgent: true });
    expect(headerOf(calls[0]!, 'Urgency')).toBe('high');
  });
  it('retries 5xx and 429', async () => {
    const { send } = make(new Response(null, { status: 503 }), new Response(null, { status: 429 }), new Response(null, { status: 201 }));
    expect(await send(sub, payload, { urgent: false })).toMatchObject({ status: 'sent', attempts: 3 });
  });
  it('reports an expired subscription as gone so it can be removed', async () => {
    for (const status of [404, 410]) {
      const { send, calls } = make(new Response(null, { status }));
      expect(await send(sub, payload, { urgent: false })).toMatchObject({ status: 'gone' });
      expect(calls).toHaveLength(1);
    }
  });
  it('rejects a malformed subscription without a network call', async () => {
    const { send, calls } = make();
    expect(await send({ ...sub, p256dh: 'AAAA' }, payload, { urgent: false })).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(0);
  });
  it('only talks to https endpoints', async () => {
    const { send, calls } = make();
    expect(await send({ ...sub, endpoint: 'http://169.254.169.254/latest' }, payload, { urgent: false })).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(0);
  });
});

describe('telnyx urgent call adapter', () => {
  const make = (...steps: Array<Response | Error>) => {
    const f = scripted(...steps);
    return { ...f, call: createCallPlacer({ apiKey: 'KEY', applicationId: 'app-1', from: '+15550001111', fetch: f.fetchFn, sleep }) };
  };
  const spoken = "Hi, it's the front desk at Kemi Cuts. Tunde needs you now. Call them back as soon as you can.";

  it('starts an outbound TeXML call that speaks the line', async () => {
    const { call, calls } = make(json(200, { data: { call_sid: 'c1' } }));
    expect(await call({ to: '+15552223333', spoken, idempotencyKey: 'evt1' })).toMatchObject({ status: 'sent' });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/texml/calls/app-1');
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer KEY');
    const b = bodyOf(calls[0]!);
    expect(b).toMatchObject({ To: '+15552223333', From: '+15550001111' });
    expect(b.Texml).toContain('<Say>');
    expect(b.Texml).toContain("Hi, it&apos;s the front desk at Kemi Cuts.");
  });
  it('escapes anything that could break out of the TeXML', async () => {
    const { call, calls } = make(json(200, {}));
    await call({ to: '+15552223333', spoken: 'Tunde </Say><Dial>+1999</Dial> & co', idempotencyKey: 'e' });
    const texml: string = bodyOf(calls[0]!).Texml;
    expect(texml).not.toContain('<Dial>');
    expect(texml).toContain('&lt;/Say&gt;');
    expect(texml.match(/<Say>/g)).toHaveLength(1);
  });
  it('refuses anything that is not an E.164 number', async () => {
    const { call, calls } = make();
    expect(await call({ to: 'not a number', spoken, idempotencyKey: 'e' })).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(0);
  });
  it('retries a 5xx, but only once the first attempt actually failed (no double ring on success)', async () => {
    const a = make(json(500), json(200, {}));
    expect(await a.call({ to: '+15552223333', spoken, idempotencyKey: 'e' })).toMatchObject({ status: 'sent', attempts: 2 });
    const b = make(json(200, {}));
    await b.call({ to: '+15552223333', spoken, idempotencyKey: 'e' });
    expect(b.calls).toHaveLength(1);
  });
  it('does not retry a rejected call', async () => {
    const { call, calls } = make(json(422, { errors: [{ title: 'Invalid' }] }));
    expect(await call({ to: '+15552223333', spoken, idempotencyKey: 'e' })).toMatchObject({ status: 'rejected' });
    expect(calls).toHaveLength(1);
  });
});
