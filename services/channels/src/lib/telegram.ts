/**
 * Minimal Telegram sendMessage used by the router so replies work today. Issue C2 owns telegram-send.ts; when it exports a
 * shared sender, swap this out (see contracts/CHANGE_REQUESTS/C1-1.md). Same rules: retry 429 (honoring retry_after)
 * and 5xx with backoff, never retry other 4xx.
 */
export interface TelegramSenderConfig {
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const LIMIT = 4096;
const SAFE = 4000;

/** Telegram rejects messages over 4096 chars. Split on paragraph, then line, then space, so a long answer stays readable. */
export function splitForTelegram(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > LIMIT) {
    const window = rest.slice(0, SAFE);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > SAFE / 2 ? cut : SAFE;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function createTelegramSender(cfg: TelegramSenderConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = cfg.maxAttempts ?? 4;

  async function sendOne(chatId: string, text: string): Promise<void> {
    const token = await cfg.token();
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      });
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= attempts) throw new Error(`telegram sendMessage failed: ${res.status}`);
      let waitMs = 500 * 2 ** (attempt - 1);
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
        if (typeof body.parameters?.retry_after === 'number') waitMs = Math.min(body.parameters.retry_after, 30) * 1000;
      }
      await sleep(waitMs);
    }
  }

  return async function sendTelegram(chatId: string, text: string): Promise<void> {
    for (const part of splitForTelegram(text)) await sendOne(chatId, part);
  };
}
