import { parseTelegramStart, verifyTelegramSecret } from './lib/verify.js';
import type { InboundMessage, WebhookResult } from './lib/types.js';
import type { WebhookEvent } from './whatsapp-webhook.js';

export interface TelegramDeps {
  webhookSecret(): Promise<string>;
  enqueue(msg: InboundMessage): Promise<void>;
  now(): Date;
}

interface Update { update_id?: number; message?: { message_id?: number; text?: string; chat?: { id?: number; type?: string }; from?: { id?: number; first_name?: string; is_bot?: boolean } } }

export async function telegramWebhook(event: WebhookEvent, deps: TelegramDeps): Promise<WebhookResult> {
  const secret = event.headers['x-telegram-bot-api-secret-token'] ?? event.headers['X-Telegram-Bot-Api-Secret-Token'];
  if (!verifyTelegramSecret(secret, await deps.webhookSecret())) return { statusCode: 401, body: 'bad secret' };
  let u: Update;
  try { u = JSON.parse(event.body ?? '{}') as Update; } catch { return { statusCode: 400, body: 'bad json' }; }
  const m = u.message;
  // MVP: private chats with humans only. Groups and channels are ignored.
  if (!m?.from?.id || m.from.is_bot || m.chat?.type !== 'private' || u.update_id === undefined) return { statusCode: 200, body: 'ignored' };
  await deps.enqueue({
    channel: 'telegram', channelUserId: String(m.from.id), chatId: String(m.chat.id), channelMessageId: String(u.update_id),
    text: m.text ?? '[non-text message]', displayName: m.from.first_name, referralCode: parseTelegramStart(m.text),
    receivedAt: deps.now().toISOString(),
  });
  return { statusCode: 200, body: 'ok' };
}
