import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@1145/shared';

export const SIGNUP_TTL_SECONDS = 15 * 60;

/** The raw token goes in the URL; only its hash is stored (SIGNUP#<sha256>). */
export function newSignupToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export interface SignupRecord {
  onboardingId: string;
  channel: 'whatsapp' | 'telegram';
  channelUserId: string;
  exp: number;
}

export interface SignupStore {
  /** Conditional update: consumed = false AND exp > now  ->  set consumed = true. Returns undefined if not consumable. */
  consume(hash: string, nowSeconds: number): Promise<SignupRecord | undefined>;
}

export async function consumeSignupToken(token: string, store: SignupStore, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return store.consume(sha256Hex(token), nowSeconds);
}

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/**
 * Add-5: after Google sign-in, the binding is PENDING until the owner confirms from the chat that started signup.
 * A forwarded signup link therefore cannot silently bind a stranger's Gmail to the owner's WhatsApp.
 */
export function reverseConfirmationMessage(email: string): string {
  return `Someone just signed in to 1145 as ${maskEmail(email)} using your link. If that was you, reply YES. If not, reply NO and we'll cancel it.`;
}
