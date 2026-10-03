import type { Outcome } from '../types.js';
import { sendWithRetry, timeoutSignal, type AdapterBase } from './http.js';

export type TelegramSender = (chatId: string, text: string, opts: { silent: boolean }) => Promise<Outcome>;

/**
 * Telegram Bot API sendMessage (the shared @1145_bot, ADR-0005: no approval needed).
 * Plain text only: owner-facing copy never needs parse_mode, and caller text can never become markup.
 */
export function createTelegramSender(o: AdapterBase & { token: string }): TelegramSender {
  const f = o.fetch ?? fetch;
  return (chatId, text, { silent }) =>
    sendWithRetry(
      o,
      () => f(`https://api.telegram.org/bot${o.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_notification: silent, link_preview_options: { is_disabled: true } }),
        signal: timeoutSignal(o.timeoutMs),
      }),
      {
        secrets: [o.token],
        extraWait: (body) => {
          const s = (body as { parameters?: { retry_after?: unknown } } | undefined)?.parameters?.retry_after;
          return typeof s === 'number' ? Math.min(s * 1000, 5000) : undefined;
        },
      },
    );
}
