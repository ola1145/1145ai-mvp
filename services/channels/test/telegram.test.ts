import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/lib/types.js';
import {
  createTelegramSender, sendTelegramMessage, splitForTelegram, TELEGRAM_MAX_LENGTH, TelegramSendError,
} from '../src/telegram-send.js';
import {
  createSqsEnqueue, createTelegramWebhookDeps, telegramWebhook, type TelegramDeps,
} from '../src/telegram-webhook.js';
import type { WebhookEvent } from '../src/whatsapp-webhook.js';

// ───────────────────────── sender ─────────────────────────

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
const OK: Reply = { status: 200, body: { ok: true, result: { message_id: 7 } } };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; json: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) as Record<string, unknown> });
    const r = replies.shift() ?? OK;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function harness(replies: Reply[], over: { maxAttempts?: number; maxRetryAfterSeconds?: number } = {}) {
  const f = fakeFetch(replies);
  const sleeps: number[] = [];
  const base = { token: TOKEN, fetchImpl: f.impl, sleep: async (ms: number) => { sleeps.push(ms); }, ...over };
  return { ...f, sleeps, send: (chatId: string, text: string, extra: { silent?: boolean } = {}) => sendTelegramMessage({ ...base, chatId, text, ...extra }) };
}

const tooMany = (retryAfter?: number): Reply => ({
  status: 429,
  body: { ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter ?? '?'}`, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }) },
});

async function failure(p: Promise<unknown>): Promise<TelegramSendError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(TelegramSendError); return e as TelegramSendError; }
  throw new Error('expected the send to fail');
}

const sent0 = (h: { calls: Array<{ json: Record<string, unknown> }> }) => String(h.calls[0]?.json.text);

describe('sendTelegramMessage', () => {
  it('posts plain text to the bot API with link previews off and no parse_mode', async () => {
    const h = harness([OK]);
    const r = await h.send('15550001', 'Booked, see you at 3.');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(h.calls[0]!.init.method).toBe('POST');
    expect(h.calls[0]!.json).toEqual({ chat_id: '15550001', text: 'Booked, see you at 3.', link_preview_options: { is_disabled: true } });
    expect(h.calls[0]!.json).not.toHaveProperty('parse_mode');
    expect(h.calls[0]!.init.signal).toBeDefined();
    expect(r.messageIds).toEqual([7]);
  });

  it('can send silently', async () => {
    const h = harness([OK]);
    await h.send('15550001', 'hello', { silent: true });
    expect(h.calls[0]!.json.disable_notification).toBe(true);
  });

  describe('429', () => {
    it('waits exactly the retry_after Telegram asks for, then sends again', async () => {
      const h = harness([tooMany(7), OK]);
      await h.send('15550001', 'hello');
      expect(h.calls).toHaveLength(2);
      expect(h.sleeps).toEqual([7000]);
    });

    it('keeps honoring each retry_after across repeated 429s', async () => {
      const h = harness([tooMany(1), tooMany(3), OK]);
      await h.send('15550001', 'hello');
      expect(h.sleeps).toEqual([1000, 3000]);
      expect(h.calls).toHaveLength(3);
    });

    it('falls back to the Retry-After header, then to backoff, when the body has no retry_after', async () => {
      const header = harness([{ status: 429, headers: { 'retry-after': '4' } }, OK]);
      await header.send('15550001', 'hello');
      expect(header.sleeps).toEqual([4000]);

      const none = harness([tooMany(), OK]);
      await none.send('15550001', 'hello');
      expect(none.sleeps).toEqual([500]);
    });

    it('does not sleep past the cap: a very long retry_after fails fast so the queue can retry later', async () => {
      const h = harness([tooMany(120)], { maxRetryAfterSeconds: 30 });
      const err = await failure(h.send('15550001', 'hello'));
      expect(h.sleeps).toEqual([]);
      expect(h.calls).toHaveLength(1);
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.retryAfterSeconds).toBe(120);
    });

    it('gives up after maxAttempts and reports it as retryable', async () => {
      const h = harness([tooMany(1), tooMany(1), tooMany(1)], { maxAttempts: 3 });
      const err = await failure(h.send('15550001', 'hello'));
      expect(h.calls).toHaveLength(3);
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
    });
  });

  describe('5xx and network errors', () => {
    it('retries 5xx with exponential backoff', async () => {
      const h = harness([{ status: 502 }, { status: 503 }, OK]);
      await h.send('15550001', 'hello');
      expect(h.sleeps).toEqual([500, 1000]);
      expect(h.calls).toHaveLength(3);
    });

    it('retries a dropped connection', async () => {
      const h = harness([new TypeError('fetch failed'), OK]);
      await h.send('15550001', 'hello');
      expect(h.calls).toHaveLength(2);
    });

    it('stops after the default four attempts', async () => {
      const h = harness([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, OK]);
      const err = await failure(h.send('15550001', 'hello'));
      expect(h.calls).toHaveLength(4);
      expect(h.sleeps).toEqual([500, 1000, 2000]);
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
    });
  });

  describe('other 4xx', () => {
    it.each([400, 401, 403, 404, 409])('never retries a %i', async (status) => {
      const h = harness([{ status, body: { ok: false, error_code: status, description: 'Forbidden: bot was blocked by the user' } }, OK]);
      const err = await failure(h.send('15550001', 'hello'));
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(false);
      expect(err.description).toBe('Forbidden: bot was blocked by the user');
    });
  });

  describe('secrets', () => {
    it('never puts the bot token in an error, even when the network error or Telegram echoes it', async () => {
      const net = harness([new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)], { maxAttempts: 1 });
      const e1 = await failure(net.send('15550001', 'hello'));
      expect(`${e1.message} ${e1.description ?? ''} ${String(e1.stack)}`).not.toContain(TOKEN);

      const echo = harness([{ status: 400, body: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} says no` } }]);
      const e2 = await failure(echo.send('15550001', 'hello'));
      expect(`${e2.message} ${e2.description ?? ''}`).not.toContain(TOKEN);
    });
  });

  describe('input checks (nothing goes on the wire)', () => {
    it('refuses empty text', async () => {
      const h = harness([OK]);
      await expect(h.send('15550001', '   \n ')).rejects.toBeInstanceOf(TelegramSendError);
      expect(h.calls).toHaveLength(0);
    });

    it.each(['@somechannel', '15550001; drop', '', 'abc'])('only sends to numeric chat ids, not %j', async (chatId) => {
      const h = harness([OK]);
      await expect(h.send(chatId, 'hello')).rejects.toBeInstanceOf(TelegramSendError);
      expect(h.calls).toHaveLength(0);
    });

    it('refuses a missing token', async () => {
      const f = fakeFetch([OK]);
      await expect(sendTelegramMessage({ token: '', chatId: '1555', text: 'hi', fetchImpl: f.impl })).rejects.toBeInstanceOf(TelegramSendError);
      expect(f.calls).toHaveLength(0);
    });
  });

  describe('long replies', () => {
    it('splits at Telegram\'s 4096 character limit on a paragraph boundary, in order', async () => {
      const para = (c: string) => `${c.repeat(3000)}`;
      const text = `${para('a')}\n\n${para('b')}\n\n${'c'.repeat(100)}`;
      const h = harness([OK, OK, OK]);
      const r = await h.send('15550001', text);
      expect(sent0(h)).toBe('a'.repeat(3000)); // cut on the blank line, not mid-paragraph
      const sent = h.calls.map((c) => String(c.json.text));
      expect(sent.length).toBeGreaterThanOrEqual(2);
      for (const s of sent) expect(s.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
      expect(sent.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
      expect(sent[0]).toMatch(/^a+$/);
      expect(r.messageIds).toHaveLength(sent.length);
    });

    it('tells the caller how many parts already went out when a later part fails', async () => {
      const text = `${'a'.repeat(3500)}\n\n${'b'.repeat(3500)}`;
      const h = harness([OK, { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: nope' } }]);
      const err = await failure(h.send('15550001', text));
      expect(err.partsSent).toBe(1);
      expect(h.calls).toHaveLength(2);
    });

    it('splitForTelegram leaves short text alone and never returns an empty part', () => {
      expect(splitForTelegram('hello')).toEqual(['hello']);
      expect(splitForTelegram('x'.repeat(5000)).every((p) => p.length > 0 && p.length <= TELEGRAM_MAX_LENGTH)).toBe(true);
      expect(splitForTelegram('word '.repeat(2000)).every((p) => p.length <= TELEGRAM_MAX_LENGTH)).toBe(true);
    });
  });
});

describe('createTelegramSender (drop-in for SenderDeps.sendTelegram)', () => {
  it('reads the token lazily and sends to the chat it is given', async () => {
    const f = fakeFetch([OK]);
    const token = vi.fn(async () => TOKEN);
    const send = createTelegramSender({ token, fetchImpl: f.impl });
    expect(token).not.toHaveBeenCalled();
    await send('15550001', 'hello');
    expect(token).toHaveBeenCalledTimes(1);
    expect(f.calls[0]!.url).toContain(`/bot${TOKEN}/sendMessage`);
    expect(f.calls[0]!.json.chat_id).toBe('15550001');
  });

  it('applies the same retry rules', async () => {
    const f = fakeFetch([tooMany(2), OK]);
    const sleeps: number[] = [];
    const send = createTelegramSender({ token: async () => TOKEN, fetchImpl: f.impl, sleep: async (ms) => { sleeps.push(ms); } });
    await send('15550001', 'hello');
    expect(sleeps).toEqual([2000]);
  });
});

// ───────────────────────── webhook ─────────────────────────

const SECRET = 'webhook-secret-0123456789abcdef';
const NOW = new Date('2026-10-06T12:00:00Z');

function harnessWebhook(over: Partial<TelegramDeps> = {}) {
  const sink: InboundMessage[] = [];
  const deps: TelegramDeps = {
    webhookSecret: async () => SECRET,
    enqueue: async (m) => { sink.push(m); },
    now: () => NOW,
    ...over,
  };
  return { sink, deps };
}

const event = (body: unknown, headers: Record<string, string | undefined> = { 'x-telegram-bot-api-secret-token': SECRET }, over: Partial<WebhookEvent> = {}): WebhookEvent => ({
  requestContext: { http: { method: 'POST' } },
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...over,
});

const privateUpdate = (text: string | undefined, over: Record<string, unknown> = {}) => ({
  update_id: 900001,
  message: { message_id: 11, text, chat: { id: 15550001, type: 'private' }, from: { id: 15550001, first_name: 'Kemi', is_bot: false }, ...over },
});

describe('telegramWebhook', () => {
  describe('secret header', () => {
    it('rejects a missing or wrong secret before parsing, and enqueues nothing', async () => {
      const { sink, deps } = harnessWebhook();
      expect((await telegramWebhook(event(privateUpdate('hi'), {}), deps)).statusCode).toBe(401);
      expect((await telegramWebhook(event(privateUpdate('hi'), { 'x-telegram-bot-api-secret-token': 'nope' }), deps)).statusCode).toBe(401);
      // Not even valid JSON gets a 400: the secret check comes first.
      expect((await telegramWebhook(event('{not json', { 'x-telegram-bot-api-secret-token': 'nope' }), deps)).statusCode).toBe(401);
      expect(sink).toHaveLength(0);
    });

    it('never accepts anything when the secret is not configured', async () => {
      const { sink, deps } = harnessWebhook({ webhookSecret: async () => '' });
      expect((await telegramWebhook(event(privateUpdate('hi'), { 'x-telegram-bot-api-secret-token': '' }), deps)).statusCode).toBe(401);
      expect((await telegramWebhook(event(privateUpdate('hi'), {}), deps)).statusCode).toBe(401);
      expect(sink).toHaveLength(0);
    });

    it('accepts the header in any capitalization', async () => {
      const { sink, deps } = harnessWebhook();
      const r = await telegramWebhook(event(privateUpdate('hi'), { 'X-Telegram-Bot-Api-Secret-Token': SECRET }), deps);
      expect(r.statusCode).toBe(200);
      expect(sink).toHaveLength(1);
    });
  });

  describe('/start CODE', () => {
    it('parses the referral code from the deep link payload', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('/start AB12_cd-9')), deps);
      expect(sink[0]).toMatchObject({ channel: 'telegram', text: '/start AB12_cd-9', referralCode: 'AB12_cd-9' });
    });

    it('parses it when the command names the bot', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('/start@onefourfive_bot FRIEND1')), deps);
      expect(sink[0]!.referralCode).toBe('FRIEND1');
    });

    it('a bare /start still gets through, with no referral', async () => {
      const { sink, deps } = harnessWebhook();
      const r = await telegramWebhook(event(privateUpdate('/start')), deps);
      expect(r.statusCode).toBe(200);
      expect(sink).toHaveLength(1);
      expect(sink[0]!.referralCode).toBeUndefined();
    });

    it.each(['/start ../../etc/passwd', `/start ${'A'.repeat(65)}`, '/start ab', '/start <script>', '/startFRIEND1', 'hello /start FRIEND1'])(
      'does not treat %j as a referral',
      async (text) => {
        const { sink, deps } = harnessWebhook();
        await telegramWebhook(event(privateUpdate(text)), deps);
        expect(sink).toHaveLength(1);
        expect(sink[0]!.referralCode).toBeUndefined();
      },
    );

    it('accepts a 64 character payload (Telegram\'s maximum)', async () => {
      const { sink, deps } = harnessWebhook();
      const code = 'Z'.repeat(64);
      await telegramWebhook(event(privateUpdate(`/start ${code}`)), deps);
      expect(sink[0]!.referralCode).toBe(code);
    });
  });

  describe('chats it ignores', () => {
    const chats = [
      ['group', { id: -100200, type: 'group' }],
      ['supergroup', { id: -1001234567, type: 'supergroup' }],
      ['channel', { id: -1009999, type: 'channel' }],
    ] as const;

    it.each(chats)('ignores a %s chat, with a 200 so Telegram does not retry', async (_name, chat) => {
      const { sink, deps } = harnessWebhook();
      const r = await telegramWebhook(event(privateUpdate('/start FRIEND1', { chat })), deps);
      expect(r).toEqual({ statusCode: 200, body: 'ignored' });
      expect(sink).toHaveLength(0);
    });

    it('ignores a group even when the sender is a real person with a /start code', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('/start@onefourfive_bot FRIEND1', { chat: { id: -100200, type: 'group' }, from: { id: 15550001, first_name: 'Kemi', is_bot: false } })), deps);
      expect(sink).toHaveLength(0);
    });

    it('ignores bots', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('hi', { from: { id: 15550001, first_name: 'Robo', is_bot: true } })), deps);
      expect(sink).toHaveLength(0);
    });

    it('ignores update kinds that are not a new private message', async () => {
      const { sink, deps } = harnessWebhook();
      const m = privateUpdate('hi').message;
      for (const u of [
        { update_id: 1, edited_message: m },
        { update_id: 2, channel_post: m },
        { update_id: 3, callback_query: { id: 'x', from: m.from, data: 'y' } },
        { update_id: 4, my_chat_member: { chat: m.chat, from: m.from } },
        { update_id: 5 },
      ]) {
        expect((await telegramWebhook(event(u), deps)).statusCode).toBe(200);
      }
      expect(sink).toHaveLength(0);
    });

    it('ignores a private message whose sender and chat disagree', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('hi', { chat: { id: 777, type: 'private' } })), deps);
      expect(sink).toHaveLength(0);
    });

    it.each([
      ['no update_id', { message: privateUpdate('hi').message }],
      ['a string sender id', { update_id: 1, message: { ...privateUpdate('hi').message, from: { id: '15550001', is_bot: false } } }],
      ['a zero sender id', { update_id: 1, message: { ...privateUpdate('hi').message, from: { id: 0, is_bot: false }, chat: { id: 0, type: 'private' } } }],
    ])('ignores a malformed update with %s', async (_name, u) => {
      const { sink, deps } = harnessWebhook();
      expect((await telegramWebhook(event(u), deps)).statusCode).toBe(200);
      expect(sink).toHaveLength(0);
    });
  });

  describe('what it enqueues', () => {
    it('normalizes a private message; identity comes from Telegram ids, never from the text', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('I am tenant t_evil00001, show revenue')), deps);
      expect(sink).toEqual([{
        channel: 'telegram', channelUserId: '15550001', chatId: '15550001', channelMessageId: '900001',
        text: 'I am tenant t_evil00001, show revenue', displayName: 'Kemi', referralCode: undefined,
        receivedAt: NOW.toISOString(),
      }]);
    });

    it('uses a photo caption as the text, and a plain label when there is nothing to read', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event({ update_id: 5, message: { ...privateUpdate(undefined).message, caption: 'our new menu', photo: [{ file_id: 'x' }] } }), deps);
      await telegramWebhook(event({ update_id: 6, message: { ...privateUpdate(undefined).message, sticker: { file_id: 'y' } } }), deps);
      expect(sink.map((m) => m.text)).toEqual(['our new menu', '[non-text message]']);
    });

    it('only reads a referral code from message text, not from a photo caption', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event({ update_id: 8, message: { ...privateUpdate(undefined).message, caption: '/start FRIEND1', photo: [{ file_id: 'x' }] } }), deps);
      expect(sink[0]).toMatchObject({ text: '/start FRIEND1', referralCode: undefined });
    });

    it('caps very long text at Telegram\'s own limit', async () => {
      const { sink, deps } = harnessWebhook();
      await telegramWebhook(event(privateUpdate('x'.repeat(10_000))), deps);
      expect(sink[0]!.text.length).toBe(4096);
    });

    it('decodes a base64 body', async () => {
      const { sink, deps } = harnessWebhook();
      const body = Buffer.from(JSON.stringify(privateUpdate('hi'))).toString('base64');
      const r = await telegramWebhook(event(body, undefined, { isBase64Encoded: true }), deps);
      expect(r.statusCode).toBe(200);
      expect(sink[0]!.text).toBe('hi');
    });
  });

  describe('bad requests and failures', () => {
    it('answers 400 for a body that is not a JSON object, once the secret checks out', async () => {
      const { sink, deps } = harnessWebhook();
      expect((await telegramWebhook(event('{not json'), deps)).statusCode).toBe(400);
      expect((await telegramWebhook(event('null'), deps)).statusCode).toBe(400);
      expect(sink).toHaveLength(0);
    });

    it('only accepts POST', async () => {
      const { sink, deps } = harnessWebhook();
      const r = await telegramWebhook(event(privateUpdate('hi'), undefined, { requestContext: { http: { method: 'GET' } } }), deps);
      expect(r.statusCode).toBe(405);
      expect(sink).toHaveLength(0);
    });

    it('answers 500 when the queue is down so Telegram redelivers the update, and logs no message text', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { deps } = harnessWebhook({ enqueue: async () => { throw new Error('sqs unavailable'); } });
        const r = await telegramWebhook(event(privateUpdate('my secret plan')), deps);
        expect(r.statusCode).toBe(500);
        const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('sqs unavailable');
        expect(logged).not.toContain('my secret plan');
        expect(logged).not.toContain(SECRET);
      } finally { log.mockRestore(); }
    });

    it('answers 500 (not 401) when the secret cannot be loaded, so the misconfiguration is loud', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { sink, deps } = harnessWebhook({ webhookSecret: async () => { throw new Error('secrets manager down'); } });
        expect((await telegramWebhook(event(privateUpdate('hi')), deps)).statusCode).toBe(500);
        expect(sink).toHaveLength(0);
      } finally { log.mockRestore(); }
    });
  });
});

// ───────────────────────── production wiring ─────────────────────────

describe('createSqsEnqueue', () => {
  const msg: InboundMessage = {
    channel: 'telegram', channelUserId: '15550001', chatId: '15550001', channelMessageId: '900001',
    text: 'hello', displayName: 'Kemi', receivedAt: NOW.toISOString(),
  };

  it('sends to the FIFO queue with group = sender and dedup = message id', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const enqueue = createSqsEnqueue({ send: async (c: { input: Record<string, unknown> }) => { sent.push(c.input); return {}; } }, 'https://sqs.example.invalid/1/inbound.fifo');
    await enqueue(msg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      QueueUrl: 'https://sqs.example.invalid/1/inbound.fifo',
      MessageGroupId: 'telegram#15550001',
      MessageDeduplicationId: 'telegram#15550001#900001',
    });
    expect(JSON.parse(String(sent[0]!.MessageBody))).toEqual(msg);
  });
});

describe('handler (the Lambda entry point)', () => {
  it('exists, and says exactly what is missing when the function is not configured', async () => {
    const { handler } = await import('../src/telegram-webhook.js');
    expect(typeof handler).toBe('function');
    const saved = { id: process.env.RUNTIME_SECRET_ID, q: process.env.QUEUE_URL };
    delete process.env.RUNTIME_SECRET_ID;
    try {
      await expect(handler(event(privateUpdate('hi')))).rejects.toThrow(/RUNTIME_SECRET_ID/);
    } finally {
      if (saved.id !== undefined) process.env.RUNTIME_SECRET_ID = saved.id;
      if (saved.q !== undefined) process.env.QUEUE_URL = saved.q;
    }
  });
});

describe('createTelegramWebhookDeps', () => {
  const secretClient = (value: string | undefined, calls: string[] = []) => ({
    send: async (c: { input: { SecretId?: string } }) => { calls.push(String(c.input.SecretId)); return { SecretString: value }; },
  });
  const env = { RUNTIME_SECRET_ID: '1145/dev/runtime', QUEUE_URL: 'https://sqs.example.invalid/1/inbound.fifo' };

  it('reads TELEGRAM_WEBHOOK_SECRET from the runtime secret and caches it briefly', async () => {
    const calls: string[] = [];
    let t = 1_000_000;
    const deps = createTelegramWebhookDeps({
      env, secrets: secretClient(JSON.stringify({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TOKEN }), calls),
      sqs: { send: async () => ({}) }, nowMs: () => t,
    });
    expect(await deps.webhookSecret()).toBe(SECRET);
    expect(await deps.webhookSecret()).toBe(SECRET);
    expect(calls).toEqual(['1145/dev/runtime']);
    t += 120_000;
    await deps.webhookSecret();
    expect(calls).toHaveLength(2);
  });

  it('fails loudly when the secret has no TELEGRAM_WEBHOOK_SECRET', async () => {
    const deps = createTelegramWebhookDeps({ env, secrets: secretClient(JSON.stringify({ TELEGRAM_BOT_TOKEN: TOKEN })), sqs: { send: async () => ({}) } });
    await expect(deps.webhookSecret()).rejects.toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('fails loudly when the function is missing its environment', () => {
    expect(() => createTelegramWebhookDeps({ env: { QUEUE_URL: 'q' }, secrets: secretClient('{}'), sqs: { send: async () => ({}) } })).toThrow(/RUNTIME_SECRET_ID/);
    expect(() => createTelegramWebhookDeps({ env: { RUNTIME_SECRET_ID: 's' }, secrets: secretClient('{}'), sqs: { send: async () => ({}) } })).toThrow(/QUEUE_URL/);
  });
});
