/**
 * POST /telegram: the shared @1145_bot's webhook (ADR-0005: no approval needed).
 * Owner: issue C2 (tasks/C2.md). Contract: contracts/openapi/channels.yaml (`telegramWebhook`).
 *
 * Verify, normalize, enqueue, answer 200. No agent call here (Add-2): Telegram retries slow webhooks, and the router
 * (SQS FIFO consumer) does the thinking. Identity is only what Telegram's verified update says it is: `from.id` and
 * `chat.id`. Nothing in the message text can change who the sender is.
 *
 * The webhook is registered by scripts/telegram/set-webhook.ts with a `secret_token`, which Telegram then sends back
 * in X-Telegram-Bot-Api-Secret-Token on every update.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { parseTelegramStart, verifyTelegramSecret } from './lib/verify.js';
import type { InboundMessage, WebhookResult } from './lib/types.js';
import type { WebhookEvent } from './whatsapp-webhook.js';

export interface TelegramDeps {
  webhookSecret(): Promise<string>;
  enqueue(msg: InboundMessage): Promise<void>;
  now(): Date;
}

interface TelegramUser { id?: unknown; first_name?: unknown; is_bot?: unknown }
interface TelegramChat { id?: unknown; type?: unknown }
interface TelegramMessage { message_id?: unknown; text?: unknown; caption?: unknown; chat?: TelegramChat; from?: TelegramUser }
interface Update { update_id?: unknown; message?: TelegramMessage }

/** Telegram's own cap on message text; a longer string is not from Telegram. */
const MAX_TEXT = 4096;
const MAX_NAME = 64;
/** What the agent sees for a sticker, voice note or file: there is no text to read, and it should say so plainly. */
const NON_TEXT_PLACEHOLDER = '[non-text message]';

const IGNORED: WebhookResult = { statusCode: 200, body: 'ignored' };

const log = (message: string, fields: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', message, ...fields }));

const headerOf = (headers: WebhookEvent['headers'], name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isUserId = (v: unknown): v is number => isCount(v) && v > 0;

/** A profile name is owner free text: keep it short and on one line. It is data for the agent, never an instruction. */
const cleanName = (v: unknown): string | undefined => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME) || undefined : undefined);

function textOf(m: TelegramMessage): string {
  for (const candidate of [m.text, m.caption]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.slice(0, MAX_TEXT);
  }
  return NON_TEXT_PLACEHOLDER;
}

export async function telegramWebhook(event: WebhookEvent, deps: TelegramDeps): Promise<WebhookResult> {
  if (event.requestContext?.http?.method !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  let expected: string;
  try {
    expected = await deps.webhookSecret();
  } catch (err) {
    // Misconfigured, not forged: answer 500 so Telegram keeps retrying and the alarm fires, instead of a quiet 401.
    log('telegram webhook secret unavailable', { err: String(err) });
    return { statusCode: 500, body: 'try again' };
  }
  // The secret is checked before the body is even parsed.
  if (!verifyTelegramSecret(headerOf(event.headers, 'x-telegram-bot-api-secret-token'), expected)) return { statusCode: 401, body: 'bad secret' };

  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  let u: Update;
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    u = parsed as Update;
  } catch {
    return { statusCode: 400, body: 'bad json' };
  }

  // MVP: new messages from humans in private chats only. Groups, channels, edits, bots and button taps are ignored
  // with a 200 so Telegram does not redeliver them.
  const m = u.message;
  const fromId = m?.from?.id;
  const chatId = m?.chat?.id;
  if (!m || !isCount(u.update_id) || m.from?.is_bot !== false || m.chat?.type !== 'private') return IGNORED;
  // In a private chat the sender and the chat are the same person. If they ever differ, something is off: do not route it.
  if (!isUserId(fromId) || !isUserId(chatId) || fromId !== chatId) return IGNORED;

  const text = textOf(m);
  const msg: InboundMessage = {
    channel: 'telegram', channelUserId: String(fromId), chatId: String(chatId), channelMessageId: String(u.update_id),
    text, displayName: cleanName(m.from?.first_name), referralCode: parseTelegramStart(typeof m.text === 'string' ? m.text : undefined),
    receivedAt: deps.now().toISOString(),
  };
  try {
    await deps.enqueue(msg);
  } catch (err) {
    // Message text stays out of logs (owner free text). A 500 makes Telegram redeliver the same update_id.
    log('telegram enqueue failed', { updateId: u.update_id, err: String(err) });
    return { statusCode: 500, body: 'try again' };
  }
  return { statusCode: 200, body: 'ok' };
}

// ───────────────────────── production wiring ─────────────────────────

/** The one method we use from an AWS SDK v3 client, so tests can pass a fake. */
export interface AwsClientLike { send(command: { input: unknown }): Promise<unknown> }

/**
 * SQS FIFO: group = sender, so one owner's messages stay in order while different owners run in parallel;
 * dedup = message id, so Telegram redelivering an update inside the 5 minute window enqueues it once.
 * (The router also claims every message id, so a later replay never invokes an agent twice.)
 */
export function createSqsEnqueue(sqs: AwsClientLike, queueUrl: string): TelegramDeps['enqueue'] {
  return async (msg) => {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(msg),
      MessageGroupId: `${msg.channel}#${msg.channelUserId}`,
      MessageDeduplicationId: `${msg.channel}#${msg.channelUserId}#${msg.channelMessageId}`,
    }));
  };
}

/** Short on purpose: after scripts/telegram/set-webhook.ts rotates the secret, the old one stops working within a minute. */
const SECRET_CACHE_MS = 60_000;

export interface TelegramWebhookWiring {
  env: Record<string, string | undefined>;
  secrets: AwsClientLike;
  sqs: AwsClientLike;
  nowMs?: () => number;
  now?: () => Date;
}

/**
 * Deps from the Lambda environment. `RUNTIME_SECRET_ID` is the runtime secret `1145/<stage>/runtime` that
 * scripts/secrets/push.sh writes (key `TELEGRAM_WEBHOOK_SECRET`); `QUEUE_URL` is the inbound FIFO queue.
 */
export function createTelegramWebhookDeps(w: TelegramWebhookWiring): TelegramDeps {
  const secretId = w.env.RUNTIME_SECRET_ID;
  const queueUrl = w.env.QUEUE_URL;
  if (!secretId) throw new Error('missing env RUNTIME_SECRET_ID (see contracts/CHANGE_REQUESTS/C2-1.md)');
  if (!queueUrl) throw new Error('missing env QUEUE_URL');
  const nowMs = w.nowMs ?? Date.now;

  let cached: { value: string; at: number } | undefined;
  return {
    async webhookSecret() {
      if (cached && nowMs() - cached.at < SECRET_CACHE_MS) return cached.value;
      const r = (await w.secrets.send(new GetSecretValueCommand({ SecretId: secretId }))) as { SecretString?: string };
      const value = (JSON.parse(r.SecretString ?? '{}') as { TELEGRAM_WEBHOOK_SECRET?: unknown }).TELEGRAM_WEBHOOK_SECRET;
      if (typeof value !== 'string' || value === '') throw new Error('TELEGRAM_WEBHOOK_SECRET missing from the runtime secret');
      cached = { value, at: nowMs() };
      return value;
    },
    enqueue: createSqsEnqueue(w.sqs, queueUrl),
    now: w.now ?? (() => new Date()),
  };
}

let prodDeps: TelegramDeps | undefined;

export const handler = async (event: WebhookEvent): Promise<WebhookResult> => {
  prodDeps ??= createTelegramWebhookDeps({
    env: process.env,
    secrets: new SecretsManagerClient({}) as unknown as AwsClientLike,
    sqs: new SQSClient({}) as unknown as AwsClientLike,
  });
  return telegramWebhook(event, prodDeps);
};
