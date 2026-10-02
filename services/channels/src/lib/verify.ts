import { hmacSha256, safeEqual } from '@1145/shared';
import { timingSafeEqual } from 'node:crypto';

/** Meta: X-Hub-Signature-256 = "sha256=" + hex(HMAC_SHA256(app_secret, raw_body)). Verify BEFORE parsing JSON. */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const given = Buffer.from(signatureHeader.slice(7), 'hex');
  const expected = hmacSha256(appSecret, rawBody);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Telegram: setWebhook(secret_token) makes Telegram send X-Telegram-Bot-Api-Secret-Token on every update. */
export function verifyTelegramSecret(headerValue: string | undefined, secret: string): boolean {
  return !!headerValue && safeEqual(headerValue, secret);
}

const CODE = /^[A-Za-z0-9_-]{4,64}$/;

/** Telegram deep link payload: "/start CODE" (payload limited to 64 chars of [A-Za-z0-9_-]). */
export function parseTelegramStart(text: string | undefined): string | undefined {
  const m = /^\/start(?:@\w+)?\s+(\S+)/.exec(text ?? '');
  return m?.[1] && CODE.test(m[1]) ? m[1] : undefined;
}

/** WhatsApp click-to-chat prefill like "Hi 1145! ref:AB12CD". Users can edit it, so the redirect click log is primary. */
export function parseWhatsAppReferral(text: string | undefined): string | undefined {
  const m = /\bref[:\s-]?([A-Za-z0-9_-]{4,32})\b/i.exec(text ?? '');
  return m?.[1];
}
