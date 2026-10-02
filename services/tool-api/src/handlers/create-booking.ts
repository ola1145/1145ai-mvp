import { makeEvent, maskPhone } from '@1145/shared';
import { handle, header, HttpError, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import { IdempotentReplay, SlotTakenError, type ToolDeps, type BookingRecord } from '../lib/repo.js';
import { isWithinHours, slotInstants, spoken } from '../lib/slots.js';
import { isoDate, optStr, str } from '../lib/validate.js';

interface Body { slotStart?: unknown; serviceId?: unknown; notes?: unknown; customer?: { name?: unknown; email?: unknown; phone?: unknown } }

export async function createBooking(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'createBooking', deps);
  const idempotencyKey = header(event, 'idempotency-key');
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.includes('#')) throw new HttpError(400, 'invalid', 'Idempotency-Key header required');

  const repo = await deps.repoFor(ctx.tenantId);
  const replay = await repo.getIdempotent(idempotencyKey);
  if (replay) return json(201, replay);

  const body = parseBody<Body>(event);
  const start = isoDate(body.slotStart, 'slotStart');
  const service = await repo.getService(str(body.serviceId, 'serviceId', 80));
  if (!service?.active) throw new HttpError(404, 'unknown_service', 'service not found', "I couldn't find that service. Which service would you like?");

  const hours = await repo.getHours();
  const end = new Date(start.getTime() + service.durationMin * 60_000);
  if (!hours || !isWithinHours(hours, start, end)) {
    throw new HttpError(422, 'outside_hours', 'slot outside business hours', "We're not open then. Want me to check the nearest open time?");
  }
  if (start <= deps.now()) throw new HttpError(422, 'in_past', 'slot is in the past', 'That time has already passed. Shall I look for the next opening?');

  const customerName = str(body.customer?.name, 'customer.name', 120);
  // Phone defaults to the carrier caller ID from the token, never a model-supplied number for voice.
  const phone = ctx.channel === 'voice' ? ctx.callerE164 : optStr(body.customer?.phone, 'customer.phone', 20);
  const booking: BookingRecord = {
    bookingId: deps.newId('bk'),
    start: start.toISOString(),
    end: end.toISOString(),
    serviceId: service.serviceId,
    status: 'confirmed',
    customer: { name: customerName, phone, email: optStr(body.customer?.email, 'customer.email', 200) },
    via: ctx.channel,
    createdAt: deps.now().toISOString(),
  };
  const response = {
    bookingId: booking.bookingId, start: booking.start, end: booking.end, serviceId: booking.serviceId,
    status: booking.status, customerFirstName: customerName.split(/\s+/)[0],
    sayToCaller: `You're booked for ${service.name} on ${spoken(start, hours.timezone)}.`,
  };

  try {
    await repo.book({ booking, slotIsos: slotInstants(start, service.durationMin), idempotencyKey, response });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      throw new HttpError(409, 'slot_taken', 'slot already booked', 'That time was just taken. Let me find the next closest opening.');
    }
    if (err instanceof IdempotentReplay) return json(201, (await repo.getIdempotent(idempotencyKey)) ?? response);
    throw err;
  }

  await deps.publish(makeEvent('booking.created', ctx, {
    bookingId: booking.bookingId, start: booking.start, serviceId: booking.serviceId, via: ctx.channel,
    customerMasked: maskPhone(phone),
  }));
  return json(201, response);
}

export const handler = handle(async (e) => createBooking(e, await (await import('../deps.js')).prodDeps()));
