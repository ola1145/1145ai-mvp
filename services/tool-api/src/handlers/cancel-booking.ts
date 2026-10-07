import { makeEvent } from '@1145/shared';
import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { slotInstants } from '../lib/slots.js';
import {
  assertNotStarted, authorizeChange, bookingFields, BookingChangedError, bookingIdOf, durationMinOf, idempotencyKeyOf,
  LIFECYCLE_ERRORS, lifecycleOf, publishQuietly, reasonOf, viaOf, withVerification, type StoredBooking,
} from '../lib/booking-lifecycle.js';
import { errorOf } from '../lib/verification.js';

interface Body { reason?: unknown; verificationCode?: unknown; customerName?: unknown; bookedDay?: unknown }

/**
 * Cancel a booking and release its slot locks. Safe to repeat: cancelling a cancelled booking answers 200 and emits
 * nothing, and when two cancels race only the one that wrote the change emits booking.cancelled.
 * Customer-facing agents must verify first (verificationCode, or customerName + bookedDay).
 */
export async function cancelBooking(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'cancelBooking', deps);
  idempotencyKeyOf(event); // required by the contract; the state check below is what makes a repeat harmless
  const bookingId = bookingIdOf(event);
  const body = parseBody<Body>(event);
  const reason = reasonOf(body.reason);

  const repo = await deps.repoFor(ctx.tenantId);
  const store = lifecycleOf(repo);
  const now = deps.now();

  const { booking, issued } = await authorizeChange(ctx, () => repo.getHours(), store, bookingId, body, now);
  const already = (b: StoredBooking) => json(200, withVerification({ ...bookingFields(b), sayToCaller: "That one's already cancelled." }, issued));
  if (booking.status === 'cancelled') return already(booking);
  assertNotStarted(ctx, booking, now);

  try {
    await store.cancel({ booking, isos: slotInstants(new Date(booking.start), durationMinOf(booking)), reason, at: now.toISOString() });
  } catch (err) {
    if (!(err instanceof BookingChangedError)) throw err;
    // Someone else changed it first. If that was another cancel, this one is already done.
    const fresh: StoredBooking | undefined = await store.getBooking(bookingId);
    if (fresh?.status === 'cancelled') return already(fresh);
    throw errorOf(LIFECYCLE_ERRORS.changed);
  }

  await publishQuietly(() => deps.publish(makeEvent('booking.cancelled', ctx, {
    bookingId, start: booking.start, serviceId: booking.serviceId, via: viaOf(ctx), ...(reason ? { reason } : {}),
  })), ctx.correlationId);

  const done = { ...bookingFields({ ...booking, status: 'cancelled' }) };
  const say = ctx.principal !== 'customer-agent' ? { sayToCaller: "Okay, that's cancelled." }
    : ctx.channel === 'voice' ? { sayToCaller: "Okay, that's cancelled. Want to pick a new time while we're on the phone?" }
    : { sayToCaller: "Okay, that's cancelled. Want to pick a new time while we're chatting?" };
  return json(200, withVerification({ ...done, ...say }, issued));
}

export const handler = handle(async (e) => cancelBooking(e, await (await import('../deps.js')).prodDeps()));
