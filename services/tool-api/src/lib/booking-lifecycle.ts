import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys, type TenantContext } from '@1145/shared';
import { header, type HttpEvent } from './http.js';
import { IdempotentReplay, SlotTakenError, type BookingRecord, type TenantRepo } from './repo.js';
import { SLOT_GRANULARITY_MIN, type BusinessHours } from './slots.js';
import {
  errorOf, requireVerifiedCaller, VERIFICATION_TTL_MS, type VerificationAnswers, type VerificationRecord, type VerificationStore,
} from './verification.js';

/**
 * Reschedule and cancel: the DynamoDB access, the shared guards and the caller-facing lines.
 *
 * The handlers get the store from `repo.lifecycle` (change request T1-1 wires it into TenantRepo and ddbRepoFor, exactly
 * like T2's `repo.changes`). The store is built over the tenant-scoped DocumentClient, so IAM LeadingKeys still confines
 * every read and write to TENANT#<tid> (ADR-0003). Nothing here reads a tenant id from a request.
 */

/** A booking as persisted: the contract's BookingRecord plus what a lifecycle change adds. Key attributes are stripped. */
export type StoredBooking = BookingRecord & { cancelledAt?: string; cancelReason?: string; rescheduledAt?: string; previousStart?: string };

export class BookingChangedError extends Error { constructor() { super('booking changed underneath this request'); } }

export interface RescheduleInput {
  booking: StoredBooking;
  /** The booking as it should be afterwards (new start/end). Same bookingId. */
  moved: StoredBooking;
  /** Slot-lock instants of the old and new times (slotInstants). Locks both share are left alone. */
  oldIsos: string[];
  newIsos: string[];
  idempotencyKey: string;
  /** Stored so a retry with the same key gets the same answer. */
  response: unknown;
  /** deps.now() as ISO; the idempotency record expires 24 h after it. */
  at: string;
}
export interface CancelInput { booking: StoredBooking; isos: string[]; reason?: string; at: string }

export interface LifecycleStore extends VerificationStore {
  getIdempotent(bookingId: string, key: string): Promise<unknown | undefined>;
  /** ONE atomic write: old booking item out, new one in, old locks released, new locks taken, replay record stored.
   *  Throws SlotTakenError (a new lock is held by another booking), IdempotentReplay, or BookingChangedError. */
  reschedule(input: RescheduleInput): Promise<void>;
  /** ONE atomic write: booking flipped to cancelled and its locks released. Throws BookingChangedError when the booking
   *  is no longer confirmed at the start we read. */
  cancel(input: CancelInput): Promise<void>;
}

export function lifecycleOf(repo: TenantRepo): LifecycleStore {
  const store = (repo as TenantRepo & { lifecycle?: LifecycleStore }).lifecycle;
  if (!store) throw errorOf(LIFECYCLE_ERRORS.notWired);
  return store;
}

// ---- caller-facing errors ----------------------------------------------------------------------------------------------

export const LIFECYCLE_ERRORS = {
  notFound: {
    status: 404, code: 'booking_not_found', message: 'booking not found',
    sayToCaller: "I'm not finding that booking. Can you tell me the name it's under and the day?",
  },
  cancelled: {
    status: 409, code: 'booking_cancelled', message: 'booking is already cancelled',
    sayToCaller: "That booking's already been cancelled. Want me to set up a new time?",
  },
  started: {
    status: 409, code: 'booking_started', message: 'booking has already started',
    sayToCaller: "That appointment has already started, so I can't change it from here.",
  },
  slotTaken: {
    status: 409, code: 'slot_taken', message: 'slot already booked',
    sayToCaller: 'That time was just taken. Let me find the next closest opening.',
  },
  outsideHours: {
    status: 422, code: 'outside_hours', message: 'slot outside business hours',
    sayToCaller: "We're not open then. Want me to check the nearest open time?",
  },
  inPast: {
    status: 422, code: 'in_past', message: 'slot is in the past',
    sayToCaller: 'That time has already passed. Shall I look for the next opening?',
  },
  badSlot: {
    status: 422, code: 'invalid_slot', message: `slotStart must fall on a ${SLOT_GRANULARITY_MIN}-minute boundary`,
    sayToCaller: 'I can book on the quarter hour, like three or three fifteen. Which time works for you?',
  },
  badSlotStart: {
    status: 400, code: 'invalid', message: 'slotStart must be an ISO date-time',
    sayToCaller: "Sorry, I didn't catch that time. What time would you like?",
  },
  changed: {
    status: 409, code: 'booking_changed', message: 'booking changed while this request was running',
    sayToCaller: 'That booking just changed on me. Let me pull it up again.',
  },
  badKey: {
    status: 400, code: 'invalid', message: 'Idempotency-Key header required (8-128 chars, no #)',
    sayToCaller: 'Sorry, something went wrong on my end. Let me try that again.',
  },
  badReason: {
    status: 400, code: 'invalid', message: 'reason must be a string of at most 500 characters',
    sayToCaller: "Sorry, that's a bit long for me to pass along. Can you give me the short version?",
  },
  notWired: {
    status: 501, code: 'not_implemented', message: 'repo has no booking lifecycle store yet',
    sayToCaller: "I can't change bookings just yet. Let me take a message so the team can help.",
  },
} as const;

// ---- request guards shared by both handlers ----------------------------------------------------------------------------

const BOOKING_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The contract makes Idempotency-Key required on both operations. */
export function idempotencyKeyOf(event: HttpEvent): string {
  const k = header(event, 'idempotency-key');
  if (!k || k.length < 8 || k.length > 128 || k.includes('#')) throw errorOf(LIFECYCLE_ERRORS.badKey);
  return k;
}

/** Only the path names the booking, and only in a shape that cannot reach another key family. */
export function bookingIdOf(event: HttpEvent): string {
  const id = event.pathParameters?.bookingId;
  if (!id || !BOOKING_ID.test(id)) throw errorOf(LIFECYCLE_ERRORS.notFound);
  return id;
}

export function slotStartOf(v: unknown): Date {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 40) throw errorOf(LIFECYCLE_ERRORS.badSlotStart);
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) throw errorOf(LIFECYCLE_ERRORS.badSlotStart);
  if (d.getTime() % (SLOT_GRANULARITY_MIN * 60_000) !== 0) throw errorOf(LIFECYCLE_ERRORS.badSlot);
  return d;
}

export function reasonOf(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 500) throw errorOf(LIFECYCLE_ERRORS.badReason);
  return v.trim() || undefined;
}

export const durationMinOf = (b: StoredBooking): number => Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000);

const firstNameOf = (b: StoredBooking) => b.customer.name.trim().split(/\s+/)[0] ?? b.customer.name;
/** The Booking schema's fields. Handlers add their own `sayToCaller`. */
export const bookingFields = (b: StoredBooking) => ({
  bookingId: b.bookingId, start: b.start, end: b.end, serviceId: b.serviceId, status: b.status, customerFirstName: firstNameOf(b),
});

type Via = 'voice' | 'webchat' | 'whatsapp' | 'telegram' | 'sms' | 'dashboard' | 'admin-agent';
/** The `via` the event schema allows. */
export function viaOf(ctx: Pick<TenantContext, 'principal' | 'channel'>): Via {
  if (ctx.principal === 'admin-agent') return 'admin-agent';
  switch (ctx.channel) {
    case 'voice': case 'webchat': case 'whatsapp': case 'telegram': case 'sms': case 'dashboard': return ctx.channel;
    default: return 'admin-agent';
  }
}

/** Adds the reusable code to a response when this request had to verify the caller. */
export function withVerification<T extends object>(response: T, issued?: { code: string; expiresAt: string }): T | (T & { verificationCode: string; verificationExpiresAt: string }) {
  return issued ? { ...response, verificationCode: issued.code, verificationExpiresAt: issued.expiresAt } : response;
}

/**
 * The checks every change starts with. Customer-facing agents must prove who they are for THIS booking on THIS call
 * before anything about the booking is revealed (a booking that does not exist answers exactly like one that does not
 * match). The admin agent and the owner are authenticated principals and skip it (x-requires-verification: customer-agent).
 */
export async function authorizeChange(
  ctx: TenantContext, getHours: () => Promise<BusinessHours | undefined>, store: LifecycleStore, bookingId: string,
  answers: VerificationAnswers, now: Date,
): Promise<{ booking: StoredBooking; issued?: { code: string; expiresAt: string } }> {
  let verified: Awaited<ReturnType<typeof requireVerifiedCaller>> = {};
  if (ctx.principal === 'customer-agent') {
    verified = await requireVerifiedCaller(store, {
      // The call id comes from the signed token (or the engine's conversation id), never from the body. A token with no
      // call id falls back to the request id, which makes the code good for one request only.
      callId: ctx.callId ?? ctx.correlationId, bookingId, answers, now,
      timezone: async () => (await getHours())?.timezone ?? 'UTC',
    });
  }
  const booking = verified.booking ?? (await store.getBooking(bookingId));
  if (!booking) throw errorOf(LIFECYCLE_ERRORS.notFound);
  return { booking, issued: verified.issued };
}

/** A customer cannot change an appointment that is already under way or over. The owner and admin agent can. */
export function assertNotStarted(ctx: Pick<TenantContext, 'principal'>, booking: StoredBooking, now: Date): void {
  if (ctx.principal === 'customer-agent' && Date.parse(booking.start) <= now.getTime()) throw errorOf(LIFECYCLE_ERRORS.started);
}

/** Never lets a lifecycle failure after a committed change reach the caller as an error. */
export async function publishQuietly(publish: () => Promise<void>, requestId: string): Promise<void> {
  try { await publish(); } catch (err) {
    console.error(JSON.stringify({ level: 'error', requestId, msg: 'event publish failed after the change was committed', err: String(err) }));
  }
}

// ---- DynamoDB ----------------------------------------------------------------------------------------------------------

const RESOURCE = 'default'; // single bookable resource in the MVP; the same constant ddb-repo.ts writes locks with
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Locks and booking items are only ever deleted or taken over by the booking that owns them. */
const OWN_OR_FREE = 'attribute_not_exists(PK) OR bookingId = :bid';

type Doc = Pick<DynamoDBDocumentClient, 'send'>;
const errName = (e: unknown) => (e as { name?: string }).name;
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const segment = (v: string, name: string) => { if (!v || v.includes('#')) throw new Error(`invalid key segment: ${name}`); return v; };
const cancellationCodes = (err: unknown): string[] | undefined =>
  errName(err) === 'TransactionCanceledException'
    ? ((err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r.Code ?? 'None')
    : undefined;

/**
 * Items (all under PK TENANT#<tid>, so the tenant role's LeadingKeys condition covers them):
 *   BOOKING#<startIso>#<id>      moves on reschedule: the start is in the sort key, so the old item is deleted and a new one put
 *   SLOT#default#<iso>           one lock per 15 minutes, written with the booking and owned by it (attribute bookingId)
 *   IDEMP#reschedule:<id>:<key>  the stored answer of a reschedule, expires after 24 h
 *   VERIFY#<callKey>#<id>        codeHash, issuedAt, expiresAt, attempts; `ttl` clears it shortly after it expires
 * Every state change is a single TransactWriteItems, so a booking is never left without its locks or holding two sets.
 */
export function ddbLifecycleStore(doc: Doc, table: string, tenantId: string): LifecycleStore {
  if (!TENANT_ID.test(tenantId)) throw new Error('invalid tenant id');
  const PK = keys.tenantPk(tenantId);
  const verifySk = (callKey: string, bookingId: string) => `VERIFY#${segment(callKey, 'callKey')}#${segment(bookingId, 'bid')}`;
  const get = async (SK: string) => (await doc.send(new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }))).Item;

  return {
    async getBooking(bookingId) {
      const gsi = keys.bookingGsi1(tenantId, bookingId);
      const r = await doc.send(new QueryCommand({
        TableName: table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND GSI1SK = :b',
        ExpressionAttributeValues: { ':p': gsi.GSI1PK, ':b': gsi.GSI1SK },
      }));
      // The by-id index is eventually consistent, so right after a reschedule it can briefly list both the old and the new
      // item. Take the most recently written; a stale pick is caught by the conditions on the write.
      const items = (r.Items ?? []).filter((i) => i.PK === PK) as Array<StoredBooking & Record<string, unknown>>;
      items.sort((a, b) => (b.rescheduledAt ?? b.createdAt).localeCompare(a.rescheduledAt ?? a.createdAt));
      const item = items[0];
      if (!item) return undefined;
      const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ...booking } = item;
      return booking as StoredBooking;
    },

    async getIdempotent(bookingId, key) {
      return (await get(keys.idempotencySk(`reschedule:${segment(bookingId, 'bid')}:${key}`)))?.response;
    },

    async reschedule({ booking, moved, oldIsos, newIsos, idempotencyKey, response, at }) {
      const id = booking.bookingId;
      const bid = { ':bid': id };
      const released = oldIsos.filter((s) => !newIsos.includes(s));
      const taken = newIsos.filter((s) => !oldIsos.includes(s));
      const items = [
        { Put: { TableName: table, Item: { PK, SK: keys.idempotencySk(`reschedule:${id}:${idempotencyKey}`), response, ttl: epoch(at) + 86_400 }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Delete: {
          TableName: table, Key: { PK, SK: keys.bookingSk(booking.start, id) },
          ConditionExpression: 'attribute_exists(PK) AND #s = :confirmed',
          ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':confirmed': 'confirmed' },
        } },
        { Put: {
          TableName: table, ConditionExpression: 'attribute_not_exists(PK)',
          Item: { ...moved, PK, SK: keys.bookingSk(moved.start, id), ...keys.bookingGsi1(tenantId, id) },
        } },
        ...released.map((iso) => ({ Delete: { TableName: table, Key: { PK, SK: keys.slotSk(RESOURCE, iso) }, ConditionExpression: OWN_OR_FREE, ExpressionAttributeValues: bid } })),
        ...taken.map((iso) => ({ Put: { TableName: table, Item: { PK, SK: keys.slotSk(RESOURCE, iso), bookingId: id }, ConditionExpression: OWN_OR_FREE, ExpressionAttributeValues: bid } })),
      ];
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (err) {
        const codes = cancellationCodes(err);
        if (codes) {
          const failed = (i: number) => codes[i] === 'ConditionalCheckFailed';
          if (failed(0)) throw new IdempotentReplay();
          const firstTaken = 3 + released.length;
          for (let i = 1; i < firstTaken; i++) if (failed(i)) throw new BookingChangedError();
          for (let i = firstTaken; i < items.length; i++) if (failed(i)) throw new SlotTakenError();
        }
        throw err;
      }
    },

    async cancel({ booking, isos, reason, at }) {
      const id = booking.bookingId;
      const sets = ['#s = :cancelled', 'cancelledAt = :at'];
      const values: Record<string, string> = { ':cancelled': 'cancelled', ':confirmed': 'confirmed', ':at': at };
      if (reason) { sets.push('cancelReason = :r'); values[':r'] = reason; }
      const items = [
        { Update: {
          TableName: table, Key: { PK, SK: keys.bookingSk(booking.start, id) }, UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK) AND #s = :confirmed',
          ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: values,
        } },
        ...isos.map((iso) => ({ Delete: { TableName: table, Key: { PK, SK: keys.slotSk(RESOURCE, iso) }, ConditionExpression: OWN_OR_FREE, ExpressionAttributeValues: { ':bid': id } } })),
      ];
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (err) {
        if (cancellationCodes(err)?.includes('ConditionalCheckFailed')) throw new BookingChangedError();
        throw err;
      }
    },

    async getVerification(callKey, bookingId) {
      const item = await get(verifySk(callKey, bookingId));
      if (!item) return undefined;
      const { PK: _pk, SK: _sk, ttl: _ttl, ...rec } = item;
      return rec as VerificationRecord;
    },

    async putVerification(rec) {
      await doc.send(new PutCommand({
        TableName: table, Item: { PK, SK: verifySk(rec.callKey, rec.bookingId), ...rec, ttl: epoch(rec.expiresAt) + 3_600 },
      }));
    },

    async recordFailedAttempt(callKey, bookingId, now) {
      const SK = verifySk(callKey, bookingId);
      const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS).toISOString();
      try {
        const r = await doc.send(new UpdateCommand({
          TableName: table, Key: { PK, SK },
          UpdateExpression: 'SET expiresAt = if_not_exists(expiresAt, :exp), #ttl = if_not_exists(#ttl, :ttl), callKey = :ck, bookingId = :bid ADD attempts :one',
          ConditionExpression: 'attribute_not_exists(PK) OR expiresAt > :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':exp': expiresAt, ':ttl': epoch(expiresAt) + 3_600, ':ck': callKey, ':bid': bookingId, ':one': 1, ':now': now.toISOString() },
          ReturnValues: 'ALL_NEW',
        }));
        return Number(r.Attributes?.attempts ?? 1);
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        // The old record has expired: start a fresh window instead of carrying old misses (or an old code) forward.
        await doc.send(new PutCommand({
          TableName: table, Item: { PK, SK, callKey, bookingId, attempts: 1, expiresAt, ttl: epoch(expiresAt) + 3_600 },
        }));
        return 1;
      }
    },
  };
}

