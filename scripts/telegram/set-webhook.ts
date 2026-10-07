/**
 * Point the shared @1145_bot at our webhook and register its /start and /help commands.
 * Owner: issue C2 (tasks/C2.md). Docs: scripts/telegram/README.md.
 *
 *   pnpm exec tsx scripts/telegram/set-webhook.ts --url https://<hooks-host>/telegram [--dry-run] [--drop-pending]
 *   pnpm exec tsx scripts/telegram/set-webhook.ts --info
 *   pnpm exec tsx scripts/telegram/set-webhook.ts --delete [--drop-pending] [--dry-run]
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and (unless --url is given) TELEGRAM_WEBHOOK_URL from the
 * environment, or from a .env file read as plain KEY=VALUE data (never sourced). Neither the token nor the secret is
 * ever printed, not even in an error. --dry-run validates everything and sends nothing.
 *
 * Exit codes: 0 done, 1 Telegram or the network said no (or the webhook did not stick), 2 bad usage or config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What owners see in Telegram's command menu. Short, plain, no sales voice (1145-conversation-style). */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'start', description: 'Get set up, or pick up where we left off' },
  { command: 'help', description: 'See what I can help with' },
];

/** Only new private messages reach the router (C2 ignores everything else), so do not ask Telegram for the rest. */
const ALLOWED_UPDATES = ['message'];
const WEBHOOK_PATH = '/telegram';
/** Telegram delivers webhooks only to these ports. */
const WEBHOOK_PORTS = new Set(['', '80', '88', '443', '8443']);
const TOKEN_SHAPE = /^\d{3,20}:[A-Za-z0-9_-]{20,}$/;
/** Telegram allows 1 to 256 of [A-Za-z0-9_-]. We insist on 16+ so nobody ships "test". `openssl rand -hex 32` gives 64. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;
const REQUEST_TIMEOUT_MS = 15_000;

export interface Io {
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  /** File contents, or undefined if there is no such file. */
  readFile(path: string): string | undefined;
}

const defaultIo: Io = {
  fetch: (...a) => fetch(...a),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
};

/** KEY=VALUE lines, optional `export`, optional matching quotes. Data only: nothing is expanded or executed. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.replace(/\r$/, ''));
    if (!m?.[1]) continue;
    let v = m[2] ?? '';
    const q = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
    if (q) v = q[1] ?? '';
    vars[m[1]] = v;
  }
  return vars;
}

const USAGE = `Usage:
  pnpm exec tsx scripts/telegram/set-webhook.ts --url https://<hooks-host>/telegram [options]
  pnpm exec tsx scripts/telegram/set-webhook.ts --info
  pnpm exec tsx scripts/telegram/set-webhook.ts --delete [options]

Options:
  --url <url>        Webhook URL (or TELEGRAM_WEBHOOK_URL). https, ends in /telegram.
  --dry-run          Check the inputs and print what would happen. Sends nothing.
  --drop-pending     Also throw away updates Telegram is holding for the old webhook.
  --info             Show the bot and its current webhook. Changes nothing.
  --delete           Remove the webhook (the bot stops receiving messages).
  --env-file <path>  Read TELEGRAM_* values from this file (default: .env if it exists).
  --help             Show this.

Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (not for --info or --delete). See scripts/telegram/README.md.`;

interface Args { url?: string; dryRun: boolean; dropPending: boolean; info: boolean; del: boolean; envFile?: string; help: boolean }

function parseArgs(argv: string[]): Args | string {
  const a: Args = { dryRun: false, dropPending: false, info: false, del: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const [name, inline] = flag.startsWith('--') && flag.includes('=') ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)] : [flag, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (name) {
      case '--url': { const v = value(); if (!v) return '--url needs a value'; a.url = v; break; }
      case '--env-file': { const v = value(); if (!v) return '--env-file needs a value'; a.envFile = v; break; }
      case '--dry-run': a.dryRun = true; break;
      case '--drop-pending': a.dropPending = true; break;
      case '--info': a.info = true; break;
      case '--delete': a.del = true; break;
      case '--help': case '-h': a.help = true; break;
      default: return `unknown option ${name}`;
    }
  }
  if (a.info && a.del) return '--info and --delete cannot be used together';
  return a;
}

/** Returns the normalized URL, or a reason it is not usable. The reason never repeats the URL (it could hold credentials). */
function checkWebhookUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { error: 'is not a valid URL' }; }
  if (u.protocol !== 'https:') return { error: 'must start with https:// (Telegram only delivers to HTTPS)' };
  if (u.username || u.password) return { error: 'must not contain a username or password' };
  if (u.search || u.hash) return { error: 'must not have a query string or fragment' };
  if (!WEBHOOK_PORTS.has(u.port)) return { error: 'uses a port Telegram will not deliver to (allowed: 443, 80, 88, 8443)' };
  if (!u.pathname.endsWith(WEBHOOK_PATH)) return { error: `must end in ${WEBHOOK_PATH}, the route ChannelsStack serves` };
  return { url: u.href };
}

type ApiResult = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };

export async function main(argv: string[], env: Record<string, string | undefined>, io: Partial<Io> = {}): Promise<number> {
  const { fetch: doFetch, out, err, readFile } = { ...defaultIo, ...io };

  const args = parseArgs(argv);
  if (typeof args === 'string') { err(`${args}\n\n${USAGE}`); return 2; }
  if (args.help) { out(USAGE); return 0; }

  // Values: the environment wins; a .env file fills the gaps.
  let fileVars: Record<string, string> = {};
  const envPath = args.envFile ?? '.env';
  const fileText = readFile(envPath);
  if (fileText !== undefined) fileVars = parseEnvFile(fileText);
  else if (args.envFile) { err(`could not read ${args.envFile}`); return 2; }
  const pick = (name: string): string | undefined => (env[name] || fileVars[name] || undefined);

  const mode: 'set' | 'info' | 'delete' = args.info ? 'info' : args.del ? 'delete' : 'set';
  const problems: string[] = [];

  const token = pick('TELEGRAM_BOT_TOKEN');
  if (!token) problems.push('TELEGRAM_BOT_TOKEN is missing. Create the bot with @BotFather (/newbot) and put the token in .env.');
  else if (!TOKEN_SHAPE.test(token)) problems.push('TELEGRAM_BOT_TOKEN does not look like a BotFather token (expected 123456789:AA...).');

  let secret: string | undefined;
  let webhookUrl: string | undefined;
  if (mode === 'set') {
    secret = pick('TELEGRAM_WEBHOOK_SECRET');
    if (!secret) problems.push('TELEGRAM_WEBHOOK_SECRET is missing. Generate one with: openssl rand -hex 32');
    else if (!SECRET_SHAPE.test(secret)) problems.push('TELEGRAM_WEBHOOK_SECRET must be 16 to 256 characters of letters, digits, _ and - (openssl rand -hex 32 works).');

    const rawUrl = args.url ?? pick('TELEGRAM_WEBHOOK_URL');
    if (!rawUrl) problems.push('the webhook URL is missing. Pass --url https://<hooks-host>/telegram or set TELEGRAM_WEBHOOK_URL.');
    else {
      const checked = checkWebhookUrl(rawUrl);
      if ('error' in checked) problems.push(`the webhook URL ${checked.error}.`);
      else webhookUrl = checked.url;
    }
  }
  if (problems.length > 0) { for (const p of problems) err(p); return 2; }

  const hide = (text: string): string => {
    let t = text;
    for (const s of [token, token?.split(':')[1], secret]) if (s) t = t.split(s).join('***');
    return t;
  };

  async function call(method: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
    let res: Response;
    try {
      res = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, message: hide(`could not reach Telegram for ${method}: ${e instanceof Error ? e.message : String(e)}`) };
    }
    let json: { ok?: boolean; result?: unknown; description?: unknown; error_code?: unknown } = {};
    try { json = (await res.json()) as typeof json; } catch { /* handled below */ }
    if (res.ok && json.ok) return { ok: true, result: (json.result && typeof json.result === 'object' ? json.result : {}) as Record<string, unknown> };
    const why = typeof json.description === 'string' ? json.description : `HTTP ${res.status}`;
    return { ok: false, message: hide(`Telegram refused ${method}: ${why}`) };
  }

  const commandList = BOT_COMMANDS.map((c) => `/${c.command}`).join(', ');

  if (args.dryRun) {
    out('dry run: nothing will be sent');
    out('TELEGRAM_BOT_TOKEN: set');
    if (mode === 'set') out('TELEGRAM_WEBHOOK_SECRET: set');
    out('would call getMe (checks the bot token)');
    if (mode === 'set') {
      out(`would call setWebhook url=${webhookUrl} allowed_updates=${JSON.stringify(ALLOWED_UPDATES)} drop_pending_updates=${args.dropPending} secret_token=<hidden>`);
      out(`would call setMyCommands ${commandList}`);
      out('would call getWebhookInfo (confirms Telegram now has this URL)');
    } else if (mode === 'delete') {
      out(`would call deleteWebhook drop_pending_updates=${args.dropPending}`);
    } else {
      out('would call getWebhookInfo');
    }
    return 0;
  }

  const me = await call('getMe');
  if (!me.ok) { err(me.message); return 1; }
  out(`bot: @${typeof me.result.username === 'string' ? me.result.username : 'unknown'}`);

  if (mode === 'delete') {
    const r = await call('deleteWebhook', { drop_pending_updates: args.dropPending });
    if (!r.ok) { err(r.message); return 1; }
    out('webhook removed: the bot will not receive messages until you run this script again with --url');
    return 0;
  }

  if (mode === 'set') {
    const set = await call('setWebhook', {
      url: webhookUrl, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: args.dropPending,
    });
    if (!set.ok) { err(set.message); return 1; }
    out(`webhook set: ${webhookUrl}`);

    const cmds = await call('setMyCommands', { commands: BOT_COMMANDS });
    if (!cmds.ok) { err(cmds.message); return 1; }
    out(`commands set: ${commandList}`);
  }

  const info = await call('getWebhookInfo');
  if (!info.ok) { err(info.message); return 1; }
  const currentUrl = typeof info.result.url === 'string' ? info.result.url : '';
  const pending = typeof info.result.pending_update_count === 'number' ? info.result.pending_update_count : 0;
  const lastError = typeof info.result.last_error_message === 'string' ? hide(info.result.last_error_message) : undefined;

  if (mode === 'info') {
    out(`webhook: ${currentUrl || 'not set'}`);
    out(`updates waiting: ${pending}`);
    if (lastError) out(`last delivery error: ${lastError}`);
    return 0;
  }

  if (currentUrl !== webhookUrl) {
    err(`Telegram reports the webhook at ${currentUrl || '(nothing)'} instead of ${webhookUrl}`);
    return 1;
  }
  out(`verified: Telegram has the webhook, ${pending} update${pending === 1 ? '' : 's'} waiting`);
  if (lastError) out(`warning: Telegram's last delivery error was: ${lastError}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e: unknown) => {
    console.error(`unexpected failure: ${e instanceof Error ? e.name : 'error'}`);
    process.exitCode = 1;
  });
}
