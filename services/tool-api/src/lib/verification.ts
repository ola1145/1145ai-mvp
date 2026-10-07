import { randomInt } from 'node:crypto';
import { safeEqual, sha256Hex } from '@1145/shared';
import { HttpError } from './http.js';
import { localParts } from './slots.js';
import type { StoredBooking } from './booking-lifecycle.js';

/**
 * Caller verification for reschedule and cancel (Add-4, threat-model S-row "caller ID spoofed").
 *
 * Caller ID is a hint, not proof, and lookupCaller already hands out the first name. So before a customer-facing agent
 * may change a booking, the caller has to give the name on the booking (the last name or the full name) AND the day it
 * is booked for. The tool API checks both against the booking itself, then issues a short-lived code bound to
 * (call, booking). The model never decides whether verification happened: the server checks it on every request.
 *
 * Nothing is texted or emailed (ADR-0005), so the "code" is not something the caller hears. It is the receipt the agent
 * carries from the check to the change, and it is useless on another call or for another booking.
 */

export const VERIFICATION_TTL_MS = 10 * 60_000;
/** Failed answers (name/day or code) allowed per call and booking before the booking is locked for that call. */
export const MAX_VERIFY_ATTEMPTS = 5;

export interface VerificationRecord {
  /** callKeyOf(callId): the raw call id is never written to a key or an attribute. */
  callKey: string;
  bookingId: string;
  /** Absent while only failed attempts have been counted. Never the code itself. */
  codeHash?: string;
  issuedAt?: string;
  expiresAt: string;
  attempts: number;
}

/** Persistence for verification. Implicitly scoped to one tenant, like every repo method (see ddbLifecycleStore). */
export interface VerificationStore {
  getBooking(bookingId: string): Promise<StoredBooking | undefined>;
  getVerification(callKey: string, bookingId: string): Promise<VerificationRecord | undefined>;
  putVerification(rec: VerificationRecord): Promise<void>;
  /** Atomically count one failed answer and return the new total. An expired record starts a fresh window. */
  recordFailedAttempt(callKey: string, bookingId: string, now: Date): Promise<number>;
}

// ---- caller-facing errors ----------------------------------------------------------------------------------------------

export const VERIFICATION_ERRORS = {
  required: {
    status: 403, code: 'verification_required', message: 'verification code missing or wrong',
    sayToCaller: "Before I change anything, I just need to make sure it's you. What's the name on the booking, and what day is it for?",
  },
  failed: {
    status: 403, code: 'verification_failed', message: 'name, day or code did not match',
    sayToCaller: "Hmm, that doesn't match what I have. Could you give me the name on the booking and the day again?",
  },
  locked: {
    status: 403, code: 'verification_locked', message: 'too many failed attempts for this booking on this call',
    sayToCaller: "I can't confirm that booking from here. Let me take a message so the team can sort it out with you.",
  },
  badDay: {
    status: 400, code: 'invalid', message: 'bookedDay must be a calendar date (YYYY-MM-DD)',
    sayToCaller: 'Sorry, I missed the day. What day is the appointment on?',
  },
} as const;

type ErrorDef = { status: number; code: string; message: string; sayToCaller: string };
export const errorOf = (e: ErrorDef): HttpError => new HttpError(e.status, e.code, e.message, e.sayToCaller);

// ---- matching ----------------------------------------------------------------------------------------------------------

/** How the call is keyed in storage: a hash, so a call id with '#' (or anything else odd) cannot touch key parsing. */
export const callKeyOf = (callId: string): string => sha256Hex(callId).slice(0, 32);
const codeHashOf = (callKey: string, bookingId: string, code: string) => sha256Hex(`${callKey}:${bookingId}:${code}`);
const newSixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const normName = (s: string) => s
  .normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  .replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * True when what the caller said is the booking's surname or full name. Every word they gave must be in the booking's
 * name, and at least one must be a surname word (anything after the first word). The first name alone never passes:
 * lookupCaller returns it to anyone who dials from that number.
 */
export function nameMatches(given: unknown, bookingName: string): boolean {
  if (typeof given !== 'string') return false;
  const g = normName(given).split(' ').filter(Boolean);
  const b = normName(bookingName).split(' ').filter(Boolean);
  if (g.length === 0 || b.length === 0) return false;
  if (!g.every((w) => b.includes(w))) return false;
  const surnames = b.length === 1 ? b : b.slice(1);
  return g.some((w) => surnames.includes(w));
}

/** `YYYY-MM-DD` as given, or an ISO date-time converted to the business's calendar day. Anything else: undefined. */
export function parseBookedDay(v: unknown, timeZone: string): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = new Date(s);
    return Number.isNaN(t.getTime()) ? undefined : localParts(t, timeZone).ymd;
  }
  return undefined;
}

// ---- issue and check ---------------------------------------------------------------------------------------------------

const live = (rec: VerificationRecord | undefined, now: Date) => (rec && Date.parse(rec.expiresAt) > now.getTime() ? rec : undefined);

export type IssueResult =
  | { ok: true; code: string; expiresAt: string; booking: StoredBooking }
  | { ok: false; reason: 'mismatch' | 'locked' };

export interface IssueInput {
  /** From the verified token or conversation id, never from the request body. */
  callId: string;
  bookingId: string;
  name: unknown;
  /** Already parsed to the business's calendar day (parseBookedDay). */
  bookedDay: string;
  timezone: string;
  now: Date;
  /** Test seam. */
  newCode?: () => string;
}

/**
 * issueVerification(callId, bookingId): when the name and the booked day match the booking, store a hashed code bound
 * to this call and booking for 10 minutes and return it. A miss is counted; after MAX_VERIFY_ATTEMPTS the booking is
 * locked for this call until the window ends. A booking that does not exist counts nothing and writes nothing.
 */
export async function issueVerification(store: VerificationStore, input: IssueInput): Promise<IssueResult> {
  const callKey = callKeyOf(input.callId);
  const existing = live(await store.getVerification(callKey, input.bookingId), input.now);
  if (existing && existing.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'locked' };

  const booking = await store.getBooking(input.bookingId);
  if (!booking) return { ok: false, reason: 'mismatch' };

  const dayMatches = localParts(new Date(booking.start), input.timezone).ymd === input.bookedDay;
  if (!dayMatches || !nameMatches(input.name, booking.customer.name)) {
    const n = await store.recordFailedAttempt(callKey, input.bookingId, input.now);
    return { ok: false, reason: n >= MAX_VERIFY_ATTEMPTS ? 'locked' : 'mismatch' };
  }

  const code = (input.newCode ?? newSixDigitCode)();
  const expiresAt = new Date(input.now.getTime() + VERIFICATION_TTL_MS).toISOString();
  await store.putVerification({
    callKey, bookingId: input.bookingId, codeHash: codeHashOf(callKey, input.bookingId, code),
    issuedAt: input.now.toISOString(), expiresAt, attempts: existing?.attempts ?? 0,
  });
  return { ok: true, code, expiresAt, booking };
}

export type CheckResult = { ok: true } | { ok: false; reason: 'missing' | 'expired' | 'mismatch' | 'locked' };

/** Is `code` the live code issued to THIS call for THIS booking? Wrong codes are counted like wrong names. */
export async function checkVerification(
  store: VerificationStore,
  input: { callId: string; bookingId: string; code: unknown; now: Date },
): Promise<CheckResult> {
  const callKey = callKeyOf(input.callId);
  const rec = await store.getVerification(callKey, input.bookingId);
  if (!rec) return { ok: false, reason: 'missing' };
  if (Date.parse(rec.expiresAt) <= input.now.getTime()) return { ok: false, reason: 'expired' };
  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (!rec.codeHash) return { ok: false, reason: 'missing' };

  const given = typeof input.code === 'string' ? input.code.trim() : '';
  if (given && safeEqual(codeHashOf(callKey, input.bookingId, given), rec.codeHash)) return { ok: true };
  const n = await store.recordFailedAttempt(callKey, input.bookingId, input.now);
  return { ok: false, reason: n >= MAX_VERIFY_ATTEMPTS ? 'locked' : 'mismatch' };
}

// ---- the gate the handlers use -----------------------------------------------------------------------------------------

export interface VerificationAnswers { verificationCode?: unknown; customerName?: unknown; bookedDay?: unknown }

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : undefined);

/**
 * Throws a 403 with a natural line unless the caller proves who they are for this booking on this call. Two ways in:
 *  1. `verificationCode` issued earlier on this call for this booking;
 *  2. `customerName` + `bookedDay`, checked right now (issuing a fresh code, returned so the agent can reuse it).
 * Returns the booking when it had to be read, so the handler does not read it twice.
 */
export async function requireVerifiedCaller(
  store: VerificationStore,
  input: { callId: string; bookingId: string; answers: VerificationAnswers; timezone: () => Promise<string>; now: Date },
): Promise<{ booking?: StoredBooking; issued?: { code: string; expiresAt: string } }> {
  const { callId, bookingId, answers, now } = input;
  const code = text(answers.verificationCode, 64);
  const name = text(answers.customerName, 120);
  const hasNameAndDay = name !== undefined && text(answers.bookedDay, 40) !== undefined;

  if (code) {
    const r = await checkVerification(store, { callId, bookingId, code, now });
    if (r.ok) return {};
    if (r.reason === 'locked') throw errorOf(VERIFICATION_ERRORS.locked);
    if (!hasNameAndDay) throw errorOf(r.reason === 'mismatch' ? VERIFICATION_ERRORS.failed : VERIFICATION_ERRORS.required);
  }
  if (!hasNameAndDay) throw errorOf(VERIFICATION_ERRORS.required);

  const timezone = await input.timezone();
  const bookedDay = parseBookedDay(answers.bookedDay, timezone);
  if (!bookedDay) throw errorOf(VERIFICATION_ERRORS.badDay); // a formatting slip is not a failed answer

  const r = await issueVerification(store, { callId, bookingId, name, bookedDay, timezone, now });
  if (r.ok) return { booking: r.booking, issued: { code: r.code, expiresAt: r.expiresAt } };
  throw errorOf(r.reason === 'locked' ? VERIFICATION_ERRORS.locked : VERIFICATION_ERRORS.failed);
}
