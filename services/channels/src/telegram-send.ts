/**
 * Telegram sendMessage for the shared bot (ADR-0005: BotFather is instant, no approval).
 * Owner: issue C2 (tasks/C2.md). The setWebhook script lives in scripts/telegram.
 *
 * Rules the Bot API forces on us:
 *  - 429 carries `parameters.retry_after` (seconds). Retrying sooner just earns another 429, so wait exactly that long.
 *  - 5xx and dropped connections are worth a few backoff retries.
 *  - Any other 4xx (blocked bot, bad chat id, bad token) will never succeed on retry, so it fails at once.
 *
 * The text is sent as plain text: no parse_mode, so anything an owner or customer typed can never become markup, and
 * link previews are off so a signup link is not fetched by Telegram's preview crawler (threat model SEC-20).
 * This module never writes words of its own; callers own the copy and run it through @1145/conversation-style.
 */

export const TELEGRAM_MAX_LENGTH = 4096;
/** Cut a little under the hard limit so a split never lands on the edge (Telegram counts some emoji as two). */
const SPLIT_WINDOW = 4000;

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Longest retry_after we will sleep through inside one invocation; beyond it we fail fast and let the queue retry. */
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 20;
const BACKOFF_BASE_MS = 500;

/** BotFather tokens look like 123456789:AA... The shape check keeps a bad secret from becoming a path in the URL. */
const TOKEN_SHAPE = /^\d{3,20}:[A-Za-z0-9_-]{20,}$/;
/** Private chats only in the MVP: Telegram user ids are plain integers. Never a @channelname. */
const CHAT_ID_SHAPE = /^-?\d{1,20}$/;

export interface SendTelegramOptions {
  token: string;
  chatId: string;
  text: string;
  /** Deliver without a notification sound (quiet-hours notices). */
  silent?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries per message part, including the first. Default 4. */
  maxAttempts?: number;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** A retry_after longer than this fails fast instead of sleeping. Default 20 s. */
  maxRetryAfterSeconds?: number;
}

export interface SendTelegramResult {
  /** Telegram message ids, one per part, in send order. */
  messageIds: number[];
}

export class TelegramSendError extends Error {
  /** HTTP status from Telegram. Undefined for network failures and for input we refused before sending. */
  readonly status: number | undefined;
  /** True when trying again later could work (429, 5xx, network). False for the rest: do not requeue. */
  readonly retryable: boolean;
  /** Seconds Telegram asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | undefined;
  /** Telegram's own explanation (for example "Forbidden: bot was blocked by the user"), token removed. */
  readonly description: string | undefined;
  /** How many earlier parts of a long reply already went out before this failure. */
  partsSent = 0;

  constructor(message: string, o: { status?: number; retryable: boolean; retryAfterSeconds?: number; description?: string }) {
    super(message);
    this.name = 'TelegramSendError';
    this.status = o.status;
    this.retryable = o.retryable;
    this.retryAfterSeconds = o.retryAfterSeconds;
    this.description = o.description;
  }
}

/**
 * Telegram rejects text over 4096 characters. Split on a paragraph, then a line, then a space, so a long answer stays
 * readable, and never in the middle of a surrogate pair.
 */
export function splitForTelegram(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    const window = rest.slice(0, SPLIT_WINDOW);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    let at = cut > SPLIT_WINDOW / 2 ? cut : SPLIT_WINDOW;
    const before = rest.charCodeAt(at - 1);
    if (before >= 0xd800 && before <= 0xdbff) at -= 1; // do not strand half an emoji
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number) => BACKOFF_BASE_MS * 2 ** (attempt - 1);

interface BotApiBody { ok?: boolean; description?: unknown; result?: { message_id?: unknown }; parameters?: { retry_after?: unknown } }

async function readBody(res: Response): Promise<BotApiBody> {
  try {
    const parsed: unknown = await res.json();
    return parsed && typeof parsed === 'object' ? (parsed as BotApiBody) : {};
  } catch {
    return {};
  }
}

/** Seconds to wait before retrying a 429: Telegram's body first, then a Retry-After header. Undefined if neither is usable. */
function retryAfterSeconds(body: BotApiBody, res: Response): number | undefined {
  const fromBody = body.parameters?.retry_after;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : undefined;
}

async function sendPart(o: SendTelegramOptions, text: string): Promise<number | undefined> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const maxAttempts = Math.max(1, o.maxAttempts ?? DEFAULT_ATTEMPTS);
  const maxWaitSeconds = o.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
  const hide = (s: string) => s.split(o.token).join('***').slice(0, 300);
  const url = `https://api.telegram.org/bot${o.token}/sendMessage`;
  const payload = JSON.stringify({
    chat_id: o.chatId, text, link_preview_options: { is_disabled: true }, ...(o.silent ? { disable_notification: true } : {}),
  });

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
        signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new TelegramSendError(`telegram sendMessage failed: network error (${hide(err instanceof Error ? err.message : String(err))})`, { retryable: true });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    const body = await readBody(res);
    if (res.ok) return typeof body.result?.message_id === 'number' ? body.result.message_id : undefined;

    const description = typeof body.description === 'string' ? hide(body.description) : undefined;
    const fail = (retryable: boolean, extra: { retryAfterSeconds?: number } = {}) => new TelegramSendError(
      `telegram sendMessage failed: ${res.status}${description ? ` ${description}` : ''}`,
      { status: res.status, retryable, description, ...extra },
    );

    if (res.status === 429) {
      const wait = retryAfterSeconds(body, res);
      // Retrying before retry_after is up only extends the penalty; past our cap, hand it back to the queue instead.
      if (wait !== undefined && wait > maxWaitSeconds) throw fail(true, { retryAfterSeconds: wait });
      if (attempt >= maxAttempts) throw fail(true, wait === undefined ? {} : { retryAfterSeconds: wait });
      await sleep(wait !== undefined ? wait * 1000 : backoffMs(attempt));
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= maxAttempts) throw fail(true);
      await sleep(backoffMs(attempt));
      continue;
    }
    throw fail(false); // 400, 401, 403 (blocked), 404, 409 ...: retrying cannot change the answer
  }
}

/**
 * Send one reply to one Telegram chat, splitting it if it is longer than Telegram allows.
 * The chat id must come from the verified inbound update (or a stored identity binding), never from model output.
 */
export async function sendTelegramMessage(o: SendTelegramOptions): Promise<SendTelegramResult> {
  if (!TOKEN_SHAPE.test(o.token)) throw new TelegramSendError('telegram bot token is missing or malformed', { retryable: false });
  if (!CHAT_ID_SHAPE.test(o.chatId)) throw new TelegramSendError('telegram chat id must be a numeric id', { retryable: false });
  const parts = splitForTelegram(o.text);
  if (parts.length === 0) throw new TelegramSendError('telegram message text is empty', { retryable: false });

  const messageIds: number[] = [];
  for (const [i, part] of parts.entries()) {
    try {
      const id = await sendPart(o, part);
      if (id !== undefined) messageIds.push(id);
    } catch (err) {
      if (err instanceof TelegramSendError) err.partsSent = i;
      throw err;
    }
  }
  return { messageIds };
}

export interface TelegramSenderConfig {
  /** Read lazily on each send so a rotated secret is picked up without a redeploy. */
  token: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  maxRetryAfterSeconds?: number;
}

/** Same shape as `SenderDeps.sendTelegram` in ./lib/senders.ts, so the router can use it as a drop-in. */
export function createTelegramSender(cfg: TelegramSenderConfig): (chatId: string, text: string) => Promise<void> {
  const { token, ...rest } = cfg;
  return async (chatId, text) => {
    await sendTelegramMessage({ ...rest, token: await token(), chatId, text });
  };
}
