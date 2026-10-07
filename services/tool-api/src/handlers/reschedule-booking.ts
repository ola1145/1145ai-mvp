import { makeEvent } from '@1145/shared';
import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import { IdempotentReplay, SlotTakenError, type ToolDeps } from '../lib/repo.js';
import { isWithinHours, slotInstants, spoken } from '../lib/slots.js';
import {
  assertNotStarted, authorizeChange, bookingFields, BookingChangedError, bookingIdOf, durationMinOf, idempotencyKeyOf,
  LIFECYCLE_ERRORS, lifecycleOf, publishQuietly, slotStartOf, viaOf, withVerification, type StoredBooking,
} from '../lib/booking-lifecycle.js';
import { errorOf } from '../lib/verification.js';

interface Body { slotStart?: unknown; verificationCode?: unknown; customerName?: unknown; bookedDay?: unknown }

/**
 * Move a booking to another time. The booking is named by the path; the tenant comes from the credential.
 * Customer-facing agents must verify first (verificationCode, or customerName + bookedDay). The booking, its slot locks
 * and the replay record change in one DynamoDB transaction, so a conflict leaves the old time exactly as it was.
 */
export async function rescheduleBooking(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'rescheduleBooking', deps);
  const idempotencyKey = idempotencyKeyOf(event);
  const bookingId = bookingIdOf(event);
  const body = parseBody<Body>(event);
  const start = slotStartOf(body.slotStart);

  const repo = await deps.repoFor(ctx.tenantId);
  const store = lifecycleOf(repo);
  const now = deps.now();
  let hoursRead: ReturnType<typeof repo.getHours> | undefined;
  const hoursOnce = () => (hoursRead ??= repo.getHours());

  const { booking, issued } = await authorizeChange(ctx, hoursOnce, store, bookingId, body, now);

  const replay = await store.getIdempotent(bookingId, idempotencyKey);
  if (replay) return json(200, withVerification(replay as object, issued));

  if (booking.status === 'cancelled') throw errorOf(LIFECYCLE_ERRORS.cancelled);
  assertNotStarted(ctx, booking, now);

  const hours = await hoursOnce();
  const durationMin = durationMinOf(booking);
  const end = new Date(start.getTime() + durationMin * 60_000);
  if (!hours || !isWithinHours(hours, start, end)) throw errorOf(LIFECYCLE_ERRORS.outsideHours);
  if (start <= now) throw errorOf(LIFECYCLE_ERRORS.inPast);

  const when = spoken(start, hours.timezone, now);
  if (start.toISOString() === booking.start) {
    return json(200, withVerification({ ...bookingFields(booking), sayToCaller: `You're already booked for ${when}, so nothing needs to change.` }, issued));
  }

  const moved: StoredBooking = {
    ...booking, start: start.toISOString(), end: end.toISOString(), previousStart: booking.start, rescheduledAt: now.toISOString(),
  };
  const response = { ...bookingFields(moved), sayToCaller: `Done. You're moved to ${when}.` };
  try {
    await store.reschedule({
      booking, moved, idempotencyKey, response, at: now.toISOString(),
      oldIsos: slotInstants(new Date(booking.start), durationMin),
      newIsos: slotInstants(start, durationMin),
    });
  } catch (err) {
    if (err instanceof SlotTakenError) throw errorOf(LIFECYCLE_ERRORS.slotTaken);
    if (err instanceof BookingChangedError) throw errorOf(LIFECYCLE_ERRORS.changed);
    if (err instanceof IdempotentReplay) return json(200, withVerification(((await store.getIdempotent(bookingId, idempotencyKey)) ?? response) as object, issued));
    throw err;
  }

  await publishQuietly(() => deps.publish(makeEvent('booking.updated', ctx, {
    bookingId, start: moved.start, previousStart: booking.start, serviceId: booking.serviceId, via: viaOf(ctx),
  })), ctx.correlationId);
  return json(200, withVerification(response, issued));
}

export const handler = handle(async (e) => rescheduleBooking(e, await (await import('../deps.js')).prodDeps()));
