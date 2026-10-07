import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { BOT_COMMANDS, main, parseEnvFile } from '../set-webhook.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const SECRET = 'f3a9c1d27b8e4f60a5d1c93e7b2a4f8d6e0c1b9a7d5e3f1a2b4c6d8e0f1a3b5c';
const URL_OK = 'https://abc123.execute-api.us-east-1.amazonaws.com/telegram';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_URL: URL_OK };
const SCRIPT = resolve(import.meta.dirname, '../set-webhook.ts');

type Json = Record<string, unknown>;
interface Call { method: string; url: string; body: Json; init: RequestInit }

/** A fake Bot API. `over` replaces the answer for one method; a function can throw to simulate a dropped connection. */
function fakeApi(over: Record<string, Json | (() => Json)> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, Json> = {
    getMe: { ok: true, result: { id: 123456789, is_bot: true, first_name: '1145', username: 'onefourfive_bot' } },
    setWebhook: { ok: true, result: true, description: 'Webhook was set' },
    setMyCommands: { ok: true, result: true },
    deleteWebhook: { ok: true, result: true, description: 'Webhook was deleted' },
    getWebhookInfo: { ok: true, result: { url: URL_OK, has_custom_certificate: false, pending_update_count: 0, max_connections: 20, allowed_updates: ['message'] } },
  };
  const impl = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    calls.push({ method, url, body: init.body ? (JSON.parse(String(init.body)) as Json) : {}, init });
    const a = over[method] ?? answers[method] ?? { ok: false, error_code: 404, description: 'Not Found' };
    const body = typeof a === 'function' ? a() : a;
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : Number(body.error_code ?? 400) });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function run(argv: string[], env: Record<string, string | undefined> = ENV, over: Parameters<typeof fakeApi>[0] = {}, files: Record<string, string> = {}) {
  const api = fakeApi(over);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, {
    fetch: api.impl, out: (l) => out.push(l), err: (l) => err.push(l),
    readFile: (p) => files[p],
  });
  const text = `${out.join('\n')}\n${err.join('\n')}`;
  return { code, calls: api.calls, out: out.join('\n'), err: err.join('\n'), text };
}

const never = (text: string) => { expect(text).not.toContain(TOKEN); expect(text).not.toContain(SECRET); expect(text).not.toContain(TOKEN.split(':')[1]!); };

describe('set-webhook', () => {
  describe('a real run', () => {
    it('checks the token, sets the webhook with the secret token, sets /start and /help, then verifies', async () => {
      const r = await run([]);
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => c.method)).toEqual(['getMe', 'setWebhook', 'setMyCommands', 'getWebhookInfo']);

      const hook = r.calls[1]!.body;
      expect(hook.url).toBe(URL_OK);
      expect(hook.secret_token).toBe(SECRET);
      expect(hook.allowed_updates).toEqual(['message']);
      expect(hook.drop_pending_updates).toBe(false);

      const commands = (r.calls[2]!.body.commands as Array<{ command: string; description: string }>);
      expect(commands.map((c) => c.command)).toEqual(['start', 'help']);
      expect(r.out).toContain('@onefourfive_bot');
    });

    it('puts the token only in the request path, never in a body or header', async () => {
      const r = await run([]);
      for (const c of r.calls) {
        expect(c.url).toBe(`https://api.telegram.org/bot${TOKEN}/${c.method}`);
        expect(JSON.stringify(c.body)).not.toContain(TOKEN);
        expect(JSON.stringify(c.init.headers ?? {})).not.toContain(TOKEN);
        expect(c.init.method).toBe('POST');
      }
    });

    it('never prints the token or the secret', async () => {
      const r = await run([]);
      expect(r.text.length).toBeGreaterThan(20);
      never(r.text);
    });

    it('drops queued updates only when asked', async () => {
      const r = await run(['--drop-pending']);
      expect(r.calls.find((c) => c.method === 'setWebhook')!.body.drop_pending_updates).toBe(true);
    });

    it('takes the URL from --url over the environment', async () => {
      const other = 'https://hooks.example.invalid/telegram';
      const r = await run(['--url', other], ENV, { getWebhookInfo: { ok: true, result: { url: other, pending_update_count: 0 } } });
      expect(r.code).toBe(0);
      expect(r.calls.find((c) => c.method === 'setWebhook')!.body.url).toBe(other);
    });

    it('fails when Telegram reports a different webhook than the one just set', async () => {
      const r = await run([], ENV, { getWebhookInfo: { ok: true, result: { url: 'https://elsewhere.example.invalid/telegram', pending_update_count: 0 } } });
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/elsewhere\.example\.invalid/);
    });

    it('surfaces the last delivery error Telegram holds, as a warning', async () => {
      const r = await run([], ENV, { getWebhookInfo: { ok: true, result: { url: URL_OK, pending_update_count: 3, last_error_message: 'Wrong response from the webhook: 401 Unauthorized' } } });
      expect(r.code).toBe(0);
      expect(r.text).toContain('401 Unauthorized');
      expect(r.text).toContain('3');
    });

    it('stops at the first Telegram error and says what Telegram said', async () => {
      const r = await run([], ENV, { getMe: { ok: false, error_code: 401, description: 'Unauthorized' } });
      expect(r.code).toBe(1);
      expect(r.calls.map((c) => c.method)).toEqual(['getMe']);
      expect(r.text).toContain('Unauthorized');
      never(r.text);
    });
  });

  describe('--dry-run', () => {
    it('makes no request at all and shows the plan', async () => {
      const r = await run(['--dry-run']);
      expect(r.code).toBe(0);
      expect(r.calls).toHaveLength(0);
      expect(r.out).toMatch(/dry run/i);
      for (const word of ['getMe', 'setWebhook', 'setMyCommands', 'getWebhookInfo', URL_OK, '/start', '/help']) expect(r.out).toContain(word);
      never(r.text);
    });

    it('shows that a secret token will be sent without showing it', async () => {
      const r = await run(['--dry-run']);
      expect(r.out).toMatch(/secret_token/);
      never(r.text);
    });

    it('still validates, so a dry run tells you what a real run would trip over', async () => {
      const r = await run(['--dry-run'], { ...ENV, TELEGRAM_BOT_TOKEN: undefined });
      expect(r.code).toBe(2);
      expect(r.err).toContain('TELEGRAM_BOT_TOKEN');
      expect(r.calls).toHaveLength(0);
    });

    it('plans a delete too', async () => {
      const r = await run(['--delete', '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('deleteWebhook');
      expect(r.calls).toHaveLength(0);
    });
  });

  describe('--info and --delete', () => {
    it('--info reads the bot and the webhook, needs no secret, and changes nothing', async () => {
      const r = await run(['--info'], { TELEGRAM_BOT_TOKEN: TOKEN });
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => c.method)).toEqual(['getMe', 'getWebhookInfo']);
      expect(r.out).toContain(URL_OK);
      never(r.text);
    });

    it('--delete removes the webhook', async () => {
      const r = await run(['--delete', '--drop-pending'], { TELEGRAM_BOT_TOKEN: TOKEN });
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => c.method)).toEqual(['getMe', 'deleteWebhook']);
      expect(r.calls[1]!.body.drop_pending_updates).toBe(true);
    });
  });

  describe('inputs', () => {
    it.each([
      ['http instead of https', 'http://abc.example.invalid/telegram'],
      ['credentials in the URL', 'https://user:pass@abc.example.invalid/telegram'],
      ['a different path', 'https://abc.example.invalid/whatsapp'],
      ['a query string', 'https://abc.example.invalid/telegram?x=1'],
      ['a port Telegram will not use', 'https://abc.example.invalid:9443/telegram'],
      ['not a URL', 'telegram please'],
    ])('rejects a webhook URL with %s', async (_n, url) => {
      const r = await run([], { ...ENV, TELEGRAM_WEBHOOK_URL: url });
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
      never(r.text);
    });

    it('accepts the ports Telegram allows', async () => {
      const url = 'https://abc.example.invalid:8443/telegram';
      const r = await run(['--dry-run'], { ...ENV, TELEGRAM_WEBHOOK_URL: url });
      expect(r.code).toBe(0);
    });

    it('asks for the URL when there is none', async () => {
      const r = await run([], { ...ENV, TELEGRAM_WEBHOOK_URL: undefined });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--url|TELEGRAM_WEBHOOK_URL/);
    });

    it.each(['short', 'has spaces in it 0123456789', 'bad/char/0123456789abcdef', 'x'.repeat(257)])('rejects the webhook secret %j without echoing it', async (secret) => {
      const r = await run([], { ...ENV, TELEGRAM_WEBHOOK_SECRET: secret });
      expect(r.code).toBe(2);
      expect(r.err).toContain('TELEGRAM_WEBHOOK_SECRET');
      expect(r.text).not.toContain(secret);
      expect(r.calls).toHaveLength(0);
    });

    it('rejects a token that does not look like one, without echoing it', async () => {
      const r = await run([], { ...ENV, TELEGRAM_BOT_TOKEN: 'not-a-real-token-but-secretish' });
      expect(r.code).toBe(2);
      expect(r.err).toContain('TELEGRAM_BOT_TOKEN');
      expect(r.text).not.toContain('secretish');
    });

    it('rejects unknown flags and prints usage', async () => {
      const r = await run(['--wat']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/usage/i);
    });

    it('--help prints usage and exits cleanly', async () => {
      const r = await run(['--help'], {});
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/usage/i);
      expect(r.out).toContain('--dry-run');
    });
  });

  describe('.env file', () => {
    const file = '.env';
    const body = `# comment\nexport TELEGRAM_BOT_TOKEN="${TOKEN}"\nTELEGRAM_WEBHOOK_SECRET='${SECRET}'\nTELEGRAM_WEBHOOK_URL=${URL_OK}\nOTHER=$(touch pwned)\n`;

    it('reads values from the file when the environment has none', async () => {
      const r = await run(['--env-file', file], {}, {}, { [file]: body });
      expect(r.code).toBe(0);
      expect(r.calls.find((c) => c.method === 'setWebhook')!.body.secret_token).toBe(SECRET);
      never(r.text);
    });

    it('lets the environment win over the file', async () => {
      const other = 'https://env.example.invalid/telegram';
      const r = await run(['--env-file', file, '--dry-run'], { TELEGRAM_WEBHOOK_URL: other }, {}, { [file]: body });
      expect(r.out).toContain(other);
    });

    it('parses it as data: quotes, export, comments, no expansion', () => {
      expect(parseEnvFile(body)).toMatchObject({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, OTHER: '$(touch pwned)' });
    });

    it('says so when a file you pointed at is missing', async () => {
      const r = await run(['--env-file', 'nope.env'], {}, {});
      expect(r.code).toBe(2);
      expect(r.err).toContain('nope.env');
    });
  });

  describe('secrets stay out of every failure message', () => {
    it('removes the token when Telegram echoes it back', async () => {
      const r = await run([], ENV, { getMe: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is wrong` } });
      expect(r.code).toBe(1);
      never(r.text);
    });

    it('removes the token and the secret from a network error', async () => {
      const api = fakeApi();
      const out: string[] = []; const err: string[] = [];
      const code = await main([], ENV, {
        fetch: (async () => { throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/setWebhook secret=${SECRET}`); }) as unknown as typeof fetch,
        out: (l) => out.push(l), err: (l) => err.push(l), readFile: () => undefined,
      });
      expect(api.calls).toHaveLength(0);
      expect(code).toBe(1);
      never(`${out.join('\n')}\n${err.join('\n')}`);
    });
  });

  describe('bot command descriptions (owners read these in Telegram)', () => {
    it('are /start and /help, within Telegram limits', () => {
      expect(BOT_COMMANDS.map((c) => c.command)).toEqual(['start', 'help']);
      for (const c of BOT_COMMANDS) {
        expect(c.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
        expect(c.description.length).toBeGreaterThanOrEqual(3);
        expect(c.description.length).toBeLessThanOrEqual(256);
      }
    });

    it('pass the conversation-style checker with no errors', () => {
      for (const c of BOT_COMMANDS) {
        expect(checkReply(c.description, { channel: 'chat' }).filter((i) => i.severity === 'error')).toEqual([]);
      }
    });
  });

  describe('run as a command', () => {
    it('--dry-run works end to end through tsx, offline, and prints no secret', () => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--dry-run'], {
        encoding: 'utf8', cwd: resolve(import.meta.dirname, '../../..'),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...ENV },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/dry run/i);
      never(`${r.stdout}\n${r.stderr}`);
    });
  });
});
