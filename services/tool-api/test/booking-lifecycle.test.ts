import { describe, expect, it } from 'vitest';
import { mintTenantToken, type EventEnvelope } from '@1145/shared';
import { rescheduleBooking } from '../src/handlers/reschedule-booking.js';
import { cancelBooking } from '../src/handlers/cancel-booking.js';
import { createBooking } from '../src/handlers/create-booking.js';
import { HttpError, type HttpEvent, type HttpResult } from '../src/lib/http.js';
import { IdempotentReplay, SlotTakenError } from '../src/lib/repo.js';
import {
  BookingChangedError, ddbLifecycleStore, LIFECYCLE_ERRORS, lifecycleOf,
  type CancelInput, type LifecycleStore, type RescheduleInput, type StoredBooking,
} from '../src/lib/booking-lifecycle.js';
import {
  callKeyOf, checkVerification, issueVerification, MAX_VERIFY_ATTEMPTS, nameMatches, parseBookedDay,
  VERIFICATION_ERRORS, VERIFICATION_TTL_MS, type VerificationRecord,
} from '../src/lib/verification.js';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { makeDeps, MemoryRepo, SECRET, voiceEvent } from './fakes.js';

const TENANT = 't_tenanta01';
const NOW = new Date('2026-10-02T15:00:00Z'); // Friday 10:00 in America/Chicago
const TUE_3PM = '2026-10-06T20:00:00.000Z'; // Tuesday 3 PM local, the seeded booking
const TUE_315 = '2026-10-06T20:15:00.000Z';
const WED_10AM = '2026-10-07T15:00:00.000Z';
const WED_1015 = '2026-10-07T15:15:00.000Z';

// ---- in-memory lifecycle store: same contract as ddbLifecycleStore, sharing state with MemoryRepo -------------------

class MemoryLifecycleStore implements LifecycleStore {
  verifications = new Map<string, VerificationRecord>();
  idem = new Map<string, unknown>();
  reads = 0;
  constructor(private repo: MemoryRepo) {}

  async getBooking(id: string) {
    this.reads++;
    const b = this.repo.bookings.find((x) => x.bookingId === id);
    return b ? (structuredClone(b) as StoredBooking) : undefined;
  }
  async getIdempotent(bookingId: string, key: string) { return this.idem.get(`${bookingId}:${key}`); }
  async reschedule(i: RescheduleInput) {
    const k = `${i.booking.bookingId}:${i.idempotencyKey}`;
    if (this.idem.has(k)) throw new IdempotentReplay();
    const idx = this.repo.bookings.findIndex((b) => b.bookingId === i.booking.bookingId);
    const cur = this.repo.bookings[idx];
    if (!cur || cur.status !== 'confirmed' || cur.start !== i.booking.start) throw new BookingChangedError();
    const keep = new Set(i.oldIsos);
    const added = i.newIsos.filter((s) => !keep.has(s));
    if (added.some((s) => this.repo.locks.has(s))) throw new SlotTakenError();
    for (const s of i.oldIsos) if (!i.newIsos.includes(s)) this.repo.locks.delete(s);
    for (const s of added) this.repo.locks.add(s);
    this.repo.bookings[idx] = i.moved;
    this.idem.set(k, i.response);
  }
  async cancel(i: CancelInput) {
    const cur = this.repo.bookings.find((b) => b.bookingId === i.booking.bookingId);
    if (!cur || cur.status !== 'confirmed') throw new BookingChangedError();
    Object.assign(cur, { status: 'cancelled', cancelledAt: i.at, ...(i.reason ? { cancelReason: i.reason } : {}) });
    for (const s of i.isos) this.repo.locks.delete(s);
  }
  private k = (callKey: string, bookingId: string) => `${callKey}#${bookingId}`;
  async getVerification(callKey: string, bookingId: string) { return this.verifications.get(this.k(callKey, bookingId)); }
  async putVerification(rec: VerificationRecord) { this.verifications.set(this.k(rec.callKey, rec.bookingId), structuredClone(rec)); }
  async recordFailedAttempt(callKey: string, bookingId: string, now: Date) {
    const key = this.k(callKey, bookingId);
    const cur = this.verifications.get(key);
    if (cur && Date.parse(cur.expiresAt) > now.getTime()) { cur.attempts += 1; return cur.attempts; }
    this.verifications.set(key, { callKey, bookingId, attempts: 1, expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS).toISOString() });
    return 1;
  }
}

class LifecycleRepo extends MemoryRepo { lifecycle = new MemoryLifecycleStore(this); }

// ---- helpers ----------------------------------------------------------------------------------------------------------

const said = new Set<string>(); // every caller-facing line seen in these tests; checked for style at the end

interface EvOpts { tid?: string; cid?: string; prn?: 'customer-agent' | 'admin-agent' | 'owner'; ch?: string; idem?: string | null; caller?: string }
function ev(op: 'reschedule' | 'cancel', bookingId: string, body: unknown, o: EvOpts = {}): HttpEvent {
  const token = mintTenantToken({ tid: o.tid ?? TENANT, prn: o.prn ?? 'customer-agent', cid: o.cid ?? 'call-1', clr: o.caller ?? '+12145550123', ch: o.ch ?? 'voice' }, SECRET);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (o.idem !== null) headers['idempotency-key'] = o.idem ?? `idem-${op}-01`;
  return { headers, body: JSON.stringify(body), pathParameters: { bookingId }, requestContext: { requestId: 'req-1' } };
}

const parse = (r: HttpResult) => { const b = JSON.parse(r.body); if (b.sayToCaller) said.add(b.sayToCaller); return b; };
async function fails(p: Promise<unknown>): Promise<HttpError> {
  try { await p; } catch (e) { if (e instanceof HttpError) { if (e.sayToCaller) said.add(e.sayToCaller); return e; } throw e; }
  throw new Error('expected the call to be rejected');
}
const types = (events: EventEnvelope[]) => events.map((e) => e.type);

async function seed(opts: { now?: Date } = {}) {
  const repo = new LifecycleRepo();
  const h = makeDeps({ [TENANT]: repo }, opts.now ?? NOW);
  const res = await createBooking(voiceEvent({ slotStart: TUE_3PM, serviceId: 'cut', customer: { name: 'Ada Obi' } }, { idem: 'idem-seed-01' }), h.deps);
  const bookingId = JSON.parse(res.body).bookingId as string;
  return { repo, ...h, bookingId };
}
/** A second set of deps over the same repos, at another point in time. */
const later = (repo: LifecycleRepo, ms: number) => makeDeps({ [TENANT]: repo }, new Date(NOW.getTime() + ms)).deps;

const WHO = { customerName: 'Ada Obi', bookedDay: '2026-10-06' };
const SIX = /^\d{6}$/;

// ---- verification gate -------------------------------------------------------------------------------------------------

describe('customer-agent verification', () => {
  it('rejects reschedule without a verificationCode: 403 with a natural line asking for name and day', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const err = await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }), deps));
    expect(err).toMatchObject({ status: 403, code: 'verification_required' });
    expect(err.sayToCaller).toMatch(/name/i);
    expect(err.sayToCaller).toMatch(/day/i);
    expect(repo.bookings[0]?.start).toBe(TUE_3PM);
    expect(types(published)).toEqual(['booking.created']);
  });

  it('rejects cancel without a verificationCode the same way and leaves the booking alone', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const err = await fails(cancelBooking(ev('cancel', bookingId, { reason: 'busy' }), deps));
    expect(err).toMatchObject({ status: 403, code: 'verification_required' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
    expect(repo.locks.size).toBe(2);
    expect(types(published)).toEqual(['booking.created']);
  });

  it('gives an unknown booking id the same 403 as a real one, so nothing is confirmed to an unverified caller', async () => {
    const { deps } = await seed();
    const real = await fails(cancelBooking(ev('cancel', 'bk_1', {}), deps));
    const ghost = await fails(cancelBooking(ev('cancel', 'bk_999', {}), deps));
    expect([ghost.status, ghost.code, ghost.sayToCaller]).toEqual([real.status, real.code, real.sayToCaller]);
    const ghostWithNameDay = await fails(cancelBooking(ev('cancel', 'bk_999', WHO), deps));
    expect(ghostWithNameDay).toMatchObject({ status: 403, code: 'verification_failed' });
  });

  it('verifies name + booked day in the same request, then returns a code the agent can reuse in this call', async () => {
    const { repo, deps, bookingId } = await seed();
    const res = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps);
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body.verificationCode).toMatch(SIX);
    expect(new Date(body.verificationExpiresAt).getTime()).toBe(NOW.getTime() + VERIFICATION_TTL_MS);
    // The code alone is enough for a follow-up in the same call.
    const cancelled = await cancelBooking(ev('cancel', bookingId, { verificationCode: body.verificationCode }, { idem: 'idem-cancel-02' }), deps);
    expect(cancelled.statusCode).toBe(200);
    expect(repo.bookings[0]?.status).toBe('cancelled');
  });

  it('binds the code to the call: the same code from another call is refused', async () => {
    const { repo, deps, bookingId } = await seed();
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }, { cid: 'call-A' }), deps));
    const other = await fails(cancelBooking(ev('cancel', bookingId, { verificationCode }, { cid: 'call-B' }), deps));
    expect(other).toMatchObject({ status: 403, code: 'verification_required' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
    // ...and it still works for the call it was issued to.
    expect((await cancelBooking(ev('cancel', bookingId, { verificationCode }, { cid: 'call-A' }), deps)).statusCode).toBe(200);
  });

  it('binds the code to the booking: a code for one booking does not open another', async () => {
    const { repo, deps, bookingId } = await seed();
    const second = await createBooking(voiceEvent({ slotStart: '2026-10-06T21:00:00.000Z', serviceId: 'cut', customer: { name: 'Ada Obi' } }, { idem: 'idem-seed-02' }), deps);
    const otherId = JSON.parse(second.body).bookingId as string;
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    const err = await fails(cancelBooking(ev('cancel', otherId, { verificationCode }), deps));
    expect(err.status).toBe(403);
    expect(repo.bookings.find((b) => b.bookingId === otherId)?.status).toBe('confirmed');
  });

  it('accepts the code right up to the 10-minute mark', async () => {
    const { repo, deps, bookingId } = await seed();
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    const justInside = later(repo, VERIFICATION_TTL_MS - 1000);
    expect((await cancelBooking(ev('cancel', bookingId, { verificationCode }, { idem: 'idem-cancel-03' }), justInside)).statusCode).toBe(200);
  });

  it('refuses an expired code and asks again for name and day', async () => {
    const { repo, deps, bookingId } = await seed();
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    const err = await fails(cancelBooking(ev('cancel', bookingId, { verificationCode }), later(repo, VERIFICATION_TTL_MS + 1000)));
    expect(err).toMatchObject({ status: 403, code: 'verification_required' });
    expect(err.sayToCaller).toMatch(/name/i);
    expect(repo.bookings[0]?.status).toBe('confirmed');
  });

  it('refuses a made-up code', async () => {
    const { repo, deps, bookingId } = await seed();
    parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    const err = await fails(cancelBooking(ev('cancel', bookingId, { verificationCode: '000000' }), deps));
    expect(err).toMatchObject({ status: 403, code: 'verification_failed' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
  });

  it('does not accept the first name alone: lookupCaller already hands that out to anyone with the caller ID', async () => {
    const { repo, deps, bookingId } = await seed();
    const err = await fails(cancelBooking(ev('cancel', bookingId, { customerName: 'Ada', bookedDay: '2026-10-06' }), deps));
    expect(err).toMatchObject({ status: 403, code: 'verification_failed' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
  });

  it('refuses the wrong day, and a day given as ISO date-time is read in the business timezone', async () => {
    const { repo, deps, bookingId } = await seed();
    expect((await fails(cancelBooking(ev('cancel', bookingId, { customerName: 'Obi', bookedDay: '2026-10-07' }), deps))).status).toBe(403);
    // 20:00Z is still Oct 6 in Chicago; 03:00Z on Oct 7 is the evening of Oct 6 there.
    const ok = await cancelBooking(ev('cancel', bookingId, { customerName: 'Obi', bookedDay: '2026-10-07T03:00:00Z' }), deps);
    expect(ok.statusCode).toBe(200);
    expect(repo.bookings[0]?.status).toBe('cancelled');
  });

  it('answers a malformed day with a natural question and does not count it as a failed attempt', async () => {
    const { repo, deps, bookingId } = await seed();
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS + 2; i++) {
      const err = await fails(cancelBooking(ev('cancel', bookingId, { customerName: 'Obi', bookedDay: 'friday-ish' }), deps));
      expect(err).toMatchObject({ status: 400, code: 'invalid' });
      expect(err.sayToCaller).toMatch(/day/i);
    }
    expect((await cancelBooking(ev('cancel', bookingId, WHO), deps)).statusCode).toBe(200);
    expect(repo.bookings[0]?.status).toBe('cancelled');
  });

  it('locks the booking for this call after repeated misses, even for a correct answer afterwards', async () => {
    const { repo, deps, bookingId } = await seed();
    const codes: string[] = [];
    for (let i = 1; i <= MAX_VERIFY_ATTEMPTS; i++) {
      const err = await fails(cancelBooking(ev('cancel', bookingId, { customerName: 'Nobody', bookedDay: '2026-10-06' }), deps));
      codes.push(err.code);
    }
    expect(codes).toEqual([...Array(MAX_VERIFY_ATTEMPTS - 1).fill('verification_failed'), 'verification_locked']);
    const locked = await fails(cancelBooking(ev('cancel', bookingId, WHO), deps));
    expect(locked).toMatchObject({ status: 403, code: 'verification_locked' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
    // A different call is not locked out by this one.
    expect((await cancelBooking(ev('cancel', bookingId, WHO, { cid: 'call-2' }), deps)).statusCode).toBe(200);
  });

  it('locks after repeated wrong codes too', async () => {
    const { repo, deps, bookingId } = await seed();
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) await fails(cancelBooking(ev('cancel', bookingId, { verificationCode: '111111' }), deps));
    const err = await fails(cancelBooking(ev('cancel', bookingId, { verificationCode }), deps));
    expect(err).toMatchObject({ status: 403, code: 'verification_locked' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
  });

  it('does not store the code itself', async () => {
    const { repo, deps, bookingId } = await seed();
    const { verificationCode } = parse(await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    const stored = JSON.stringify([...repo.lifecycle.verifications.values()]);
    expect(stored).not.toContain(verificationCode);
    expect(stored).not.toContain('call-1'); // the call id is hashed too
  });

  it('does not require verification for the admin agent or the owner', async () => {
    const a = await seed();
    const res = await rescheduleBooking(ev('reschedule', a.bookingId, { slotStart: WED_10AM }, { prn: 'admin-agent', ch: 'telegram' }), a.deps);
    expect(res.statusCode).toBe(200);
    const b = await seed();
    const res2 = await cancelBooking(ev('cancel', b.bookingId, {}, { prn: 'owner', ch: 'dashboard' }), b.deps);
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).verificationCode).toBeUndefined();
  });
});

describe('issueVerification / checkVerification', () => {
  const booking = (over: Partial<StoredBooking> = {}): StoredBooking => ({
    bookingId: 'bk_1', start: TUE_3PM, end: '2026-10-06T20:30:00.000Z', serviceId: 'cut', status: 'confirmed',
    customer: { name: 'Ada Obi', phone: '+12145550123' }, via: 'voice', createdAt: '2026-10-02T15:00:00.000Z', ...over,
  });
  const storeWith = (b?: StoredBooking) => {
    const repo = new LifecycleRepo();
    if (b) repo.bookings.push(b);
    return repo.lifecycle;
  };
  const input = { callId: 'call-1', bookingId: 'bk_1', name: 'Ada Obi', bookedDay: '2026-10-06', timezone: 'America/Chicago', now: NOW };

  it('issues a six-digit code bound to (callId, bookingId) with a 10-minute TTL when name and booked day match', async () => {
    const store = storeWith(booking());
    const r = await issueVerification(store, input);
    if (!r.ok) throw new Error('expected a code');
    expect(r.code).toMatch(SIX);
    expect(r.expiresAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect(VERIFICATION_TTL_MS).toBe(600_000);
    const rec = [...store.verifications.values()][0]!;
    expect(rec).toMatchObject({ callKey: callKeyOf('call-1'), bookingId: 'bk_1', expiresAt: r.expiresAt });
    expect(await checkVerification(store, { callId: 'call-1', bookingId: 'bk_1', code: r.code, now: NOW })).toEqual({ ok: true });
    expect(await checkVerification(store, { callId: 'call-2', bookingId: 'bk_1', code: r.code, now: NOW })).toMatchObject({ ok: false });
    expect(await checkVerification(store, { callId: 'call-1', bookingId: 'bk_2', code: r.code, now: NOW })).toMatchObject({ ok: false });
  });

  it('treats the expiry instant itself as expired', async () => {
    const store = storeWith(booking());
    const r = await issueVerification(store, input);
    if (!r.ok) throw new Error('expected a code');
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(await checkVerification(store, { callId: 'call-1', bookingId: 'bk_1', code: r.code, now: at(VERIFICATION_TTL_MS - 1) })).toEqual({ ok: true });
    expect(await checkVerification(store, { callId: 'call-1', bookingId: 'bk_1', code: r.code, now: at(VERIFICATION_TTL_MS) })).toEqual({ ok: false, reason: 'expired' });
  });

  it('draws the code from the injected generator, so the production source is the only random part', async () => {
    const r = await issueVerification(storeWith(booking()), { ...input, newCode: () => '424242' });
    expect(r).toMatchObject({ ok: true, code: '424242' });
  });

  it('refuses when the name or the day does not match, or the booking does not exist', async () => {
    const store = storeWith(booking());
    expect(await issueVerification(store, { ...input, name: 'Someone Else' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await issueVerification(store, { ...input, bookedDay: '2026-10-08' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await issueVerification(store, { ...input, bookingId: 'bk_404' })).toEqual({ ok: false, reason: 'mismatch' });
    expect([...store.verifications.keys()]).toHaveLength(1); // only the real booking counted misses; the ghost id wrote nothing
  });

  it('does not treat the number or the caller as proof: the booking phone is irrelevant to the check', async () => {
    const r = await issueVerification(storeWith(booking({ customer: { name: 'Ada Obi', phone: '+19995550000' } })), input);
    expect(r.ok).toBe(true);
  });

  it('matches names the way people say them', () => {
    const m = (given: string, name = 'Ada Obi') => nameMatches(given, name);
    expect(m('Obi')).toBe(true);
    expect(m('ada obi')).toBe(true);
    expect(m('  OBI  ')).toBe(true);
    expect(m('Ada')).toBe(false);
    expect(m('Obi Ada')).toBe(true);
    expect(m('Okafor')).toBe(false);
    expect(m('Ada Okafor')).toBe(false);
    expect(m('')).toBe(false);
    expect(nameMatches(undefined, 'Ada Obi')).toBe(false);
    expect(nameMatches('Zoë Müller', 'Zoe Muller')).toBe(true);
    expect(nameMatches("O'Brien", 'Sean OBrien')).toBe(true);
    expect(nameMatches('Smith Jones', 'Mary Smith-Jones')).toBe(true);
    expect(nameMatches('Madonna', 'Madonna')).toBe(true);
    expect(nameMatches('Mary', 'Mary Jane Watson')).toBe(false);
    expect(nameMatches('Watson', 'Mary Jane Watson')).toBe(true);
  });

  it('reads the booked day as a local calendar date', () => {
    expect(parseBookedDay('2026-10-06', 'America/Chicago')).toBe('2026-10-06');
    expect(parseBookedDay('2026-10-07T03:00:00Z', 'America/Chicago')).toBe('2026-10-06');
    expect(parseBookedDay('2026-02-30', 'America/Chicago')).toBeUndefined();
    expect(parseBookedDay('Friday', 'America/Chicago')).toBeUndefined();
    expect(parseBookedDay(20261006, 'America/Chicago')).toBeUndefined();
  });
});

// ---- reschedule --------------------------------------------------------------------------------------------------------

describe('rescheduleBooking', () => {
  const owner = { prn: 'owner' as const, ch: 'dashboard' };

  it('moves the slot locks together with the booking: old released, new taken, booking.updated emitted', async () => {
    const { repo, deps, published, bookingId } = await seed();
    expect([...repo.locks].sort()).toEqual([TUE_3PM, TUE_315]);
    const res = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps);
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body).toMatchObject({ bookingId, start: WED_10AM, end: '2026-10-07T15:30:00.000Z', serviceId: 'cut', status: 'confirmed', customerFirstName: 'Ada' });
    expect(body.sayToCaller).toBe("Done. You're moved to Wednesday at 10 AM.");
    expect([...repo.locks].sort()).toEqual([WED_10AM, WED_1015]);
    expect(repo.bookings[0]).toMatchObject({ start: WED_10AM, end: '2026-10-07T15:30:00.000Z', status: 'confirmed' });
    expect(types(published)).toEqual(['booking.created', 'booking.updated']);
    expect(published[1]?.data).toEqual({ bookingId, start: WED_10AM, previousStart: TUE_3PM, serviceId: 'cut', via: 'voice' });
    expect(published[1]?.tenantId).toBe(TENANT);
  });

  it('keeps the locks the new time shares with the old one when the move overlaps', async () => {
    const { repo, deps, bookingId } = await seed();
    const res = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: TUE_315 }, owner), deps);
    expect(res.statusCode).toBe(200);
    expect([...repo.locks].sort()).toEqual([TUE_315, '2026-10-06T20:30:00.000Z']);
  });

  it('answers 409 when the new time is taken and changes nothing', async () => {
    const { repo, deps, published, bookingId } = await seed();
    await createBooking(voiceEvent({ slotStart: WED_10AM, serviceId: 'cut', customer: { name: 'Sam Lee' } }, { idem: 'idem-other-01' }), deps);
    const before = { locks: [...repo.locks].sort(), start: repo.bookings[0]?.start, events: published.length };
    const err = await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM, ...WHO }), deps));
    expect(err).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(err.sayToCaller).toMatch(/taken/i);
    expect({ locks: [...repo.locks].sort(), start: repo.bookings[0]?.start, events: published.length }).toEqual(before);
  });

  it('answers 409 when only the back half of the new time overlaps another booking', async () => {
    const { repo, deps, bookingId } = await seed();
    await createBooking(voiceEvent({ slotStart: '2026-10-07T14:45:00.000Z', serviceId: 'cut', customer: { name: 'Sam Lee' } }, { idem: 'idem-other-02' }), deps);
    const err = await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps));
    expect(err).toMatchObject({ status: 409, code: 'slot_taken' });
    expect(repo.bookings[0]?.start).toBe(TUE_3PM);
  });

  it('is a quiet success when the booking is already at that time', async () => {
    const { deps, published, bookingId } = await seed();
    const res = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: TUE_3PM }, owner), deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res).sayToCaller).toMatch(/already/i);
    expect(types(published)).toEqual(['booking.created']);
  });

  it('replays the stored answer for a repeated Idempotency-Key without a second move or event', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const first = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps);
    const second = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps);
    expect(second.body).toBe(first.body);
    expect(types(published)).toEqual(['booking.created', 'booking.updated']);
    expect(repo.bookings).toHaveLength(1);
  });

  it('requires an Idempotency-Key and a usable slotStart, with a natural line either way', async () => {
    const { deps, bookingId } = await seed();
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, { ...owner, idem: null }), deps))).toMatchObject({ status: 400 });
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, { ...owner, idem: 'short' }), deps))).toMatchObject({ status: 400 });
    const noTime = await fails(rescheduleBooking(ev('reschedule', bookingId, {}, owner), deps));
    expect(noTime).toMatchObject({ status: 400, code: 'invalid' });
    expect(noTime.sayToCaller).toBeTruthy();
    const junk = await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: 'whenever' }, owner), deps));
    expect(junk).toMatchObject({ status: 400, code: 'invalid' });
    expect(junk.sayToCaller).toBeTruthy();
  });

  it('rejects times outside business hours, in the past, or off the quarter hour', async () => {
    const { repo, deps, bookingId } = await seed();
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: '2026-10-04T20:00:00.000Z' }, owner), deps))).toMatchObject({ status: 422, code: 'outside_hours' });
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: '2026-10-02T16:00:00.000Z' }, { ...owner, idem: 'idem-past-0001' }), later(repo, 3 * 3600_000)))).toMatchObject({ status: 422, code: 'in_past' });
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: '2026-10-07T15:07:00.000Z' }, owner), deps))).toMatchObject({ status: 422, code: 'invalid_slot' });
    expect(repo.bookings[0]?.start).toBe(TUE_3PM);
    expect([...repo.locks].sort()).toEqual([TUE_3PM, TUE_315]);
  });

  it('will not move a cancelled booking, and will not let a customer move one that already started', async () => {
    const { repo, deps, bookingId } = await seed();
    const started = later(repo, 4 * 86_400_000 + 5.5 * 3600_000); // Tuesday 3:30 PM local: the 3 PM visit is under way
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: '2026-10-08T15:00:00.000Z', ...WHO }, { idem: 'idem-late-0001' }), started))).toMatchObject({ status: 409, code: 'booking_started' });
    await cancelBooking(ev('cancel', bookingId, {}, owner), deps);
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps))).toMatchObject({ status: 409, code: 'booking_cancelled' });
  });

  it('answers 404 for an owner who names a booking this tenant does not have', async () => {
    const { deps } = await seed();
    expect(await fails(rescheduleBooking(ev('reschedule', 'bk_nope', { slotStart: WED_10AM }, owner), deps))).toMatchObject({ status: 404, code: 'booking_not_found' });
    expect(await fails(rescheduleBooking(ev('reschedule', 'bk#evil', { slotStart: WED_10AM }, owner), deps))).toMatchObject({ status: 404, code: 'booking_not_found' });
  });

  it('turns a lost race on the booking itself into a 409 the agent can retry', async () => {
    const { repo, deps, bookingId } = await seed();
    const real = repo.lifecycle.reschedule.bind(repo.lifecycle);
    repo.lifecycle.reschedule = async () => { throw new BookingChangedError(); };
    expect(await fails(rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps))).toMatchObject({ status: 409, code: 'booking_changed' });
    repo.lifecycle.reschedule = real;
    expect((await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, { ...owner, idem: 'idem-retry-001' }), deps)).statusCode).toBe(200);
  });

  it('reports admin-agent moves as via admin-agent', async () => {
    const { deps, published, bookingId } = await seed();
    await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, { prn: 'admin-agent', ch: 'internal' }), deps);
    expect((published[1]?.data as { via: string }).via).toBe('admin-agent');
  });

  it('is still answered when the event bus is down, because the move already happened', async () => {
    const { repo, deps, bookingId } = await seed();
    deps.publish = async () => { throw new Error('bus down'); };
    const res = await rescheduleBooking(ev('reschedule', bookingId, { slotStart: WED_10AM }, owner), deps);
    expect(res.statusCode).toBe(200);
    expect(repo.bookings[0]?.start).toBe(WED_10AM);
  });
});

// ---- cancel ------------------------------------------------------------------------------------------------------------

describe('cancelBooking', () => {
  it('releases the locks, keeps the record as cancelled, and emits booking.cancelled', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const res = await cancelBooking(ev('cancel', bookingId, { reason: 'Something came up at work', ...WHO }), deps);
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body).toMatchObject({ bookingId, start: TUE_3PM, end: '2026-10-06T20:30:00.000Z', serviceId: 'cut', status: 'cancelled', customerFirstName: 'Ada' });
    expect(body.sayToCaller).toBe("Okay, that's cancelled. Want to pick a new time while we're on the phone?");
    expect(repo.locks.size).toBe(0);
    expect(repo.bookings[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Something came up at work' });
    expect(types(published)).toEqual(['booking.created', 'booking.cancelled']);
    expect(published[1]?.data).toEqual({ bookingId, start: TUE_3PM, serviceId: 'cut', via: 'voice', reason: 'Something came up at work' });
  });

  it('frees the time for someone else to book', async () => {
    const { deps, bookingId } = await seed();
    await cancelBooking(ev('cancel', bookingId, WHO), deps);
    const res = await createBooking(voiceEvent({ slotStart: TUE_3PM, serviceId: 'cut', customer: { name: 'Sam Lee' } }, { idem: 'idem-rebook-01' }), deps);
    expect(res.statusCode).toBe(201);
  });

  it('is idempotent: cancelling twice is a success and emits one event', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const first = await cancelBooking(ev('cancel', bookingId, WHO), deps);
    const second = await cancelBooking(ev('cancel', bookingId, WHO), deps);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(parse(second)).toMatchObject({ status: 'cancelled', bookingId });
    expect(parse(second).sayToCaller).toMatch(/already/i);
    expect(types(published)).toEqual(['booking.created', 'booking.cancelled']);
    expect(repo.locks.size).toBe(0);
  });

  it('does not double-emit when two cancels race and the loser sees the winner', async () => {
    const { repo, deps, published, bookingId } = await seed();
    const real = repo.lifecycle.cancel.bind(repo.lifecycle);
    repo.lifecycle.cancel = async (i) => { await real(i); throw new BookingChangedError(); }; // someone else's write landed first
    const res = await cancelBooking(ev('cancel', bookingId, WHO), deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res).status).toBe('cancelled');
    expect(types(published)).toEqual(['booking.created']);
  });

  it('answers 409 when the booking changed under it and is still active', async () => {
    const { repo, deps, bookingId } = await seed();
    repo.lifecycle.cancel = async () => { throw new BookingChangedError(); };
    expect(await fails(cancelBooking(ev('cancel', bookingId, WHO), deps))).toMatchObject({ status: 409, code: 'booking_changed' });
  });

  it('works without a reason, and keeps the reason within 500 characters', async () => {
    const a = await seed();
    expect((await cancelBooking(ev('cancel', a.bookingId, WHO), a.deps)).statusCode).toBe(200);
    expect(a.published[1]?.data).not.toHaveProperty('reason');
    const b = await seed();
    const err = await fails(cancelBooking(ev('cancel', b.bookingId, { ...WHO, reason: 'x'.repeat(501) }), b.deps));
    expect(err).toMatchObject({ status: 400, code: 'invalid' });
    expect(err.sayToCaller).toBeTruthy();
    expect(b.repo.bookings[0]?.status).toBe('confirmed');
  });

  it('requires the Idempotency-Key header the contract lists', async () => {
    const { deps, bookingId } = await seed();
    expect(await fails(cancelBooking(ev('cancel', bookingId, WHO, { idem: null }), deps))).toMatchObject({ status: 400 });
  });

  it('words the follow-up for the channel: chat does not say "on the phone"', async () => {
    const { deps, bookingId } = await seed();
    const res = await cancelBooking(ev('cancel', bookingId, WHO, { ch: 'webchat' }), deps);
    expect(parse(res).sayToCaller).toBe("Okay, that's cancelled. Want to pick a new time while we're chatting?");
  });

  it('lets the owner cancel without a code, and says so plainly', async () => {
    const { deps, published, bookingId } = await seed();
    const res = await cancelBooking(ev('cancel', bookingId, {}, { prn: 'owner', ch: 'dashboard' }), deps);
    expect(parse(res).sayToCaller).toBe("Okay, that's cancelled.");
    expect((published[1]?.data as { via: string }).via).toBe('dashboard');
  });

  it('does not let a customer cancel an appointment that already started', async () => {
    const { repo, bookingId } = await seed();
    const started = later(repo, 4 * 86_400_000 + 5.5 * 3600_000);
    expect(await fails(cancelBooking(ev('cancel', bookingId, WHO, { idem: 'idem-late-0002' }), started))).toMatchObject({ status: 409, code: 'booking_started' });
    expect(repo.bookings[0]?.status).toBe('confirmed');
  });
});

// ---- tenant isolation --------------------------------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('ignores a tenant id in the body or query: only the token decides which repo is opened', async () => {
    const a = new LifecycleRepo(); const evil = new LifecycleRepo();
    const { deps, repoCalls } = makeDeps({ [TENANT]: a, t_evil00001: evil });
    const res = await createBooking(voiceEvent({ slotStart: TUE_3PM, serviceId: 'cut', customer: { name: 'Ada Obi' } }, { idem: 'idem-seed-01' }), deps);
    const bookingId = JSON.parse(res.body).bookingId as string;
    evil.bookings.push({ ...a.bookings[0]!, bookingId }); // same id in the other tenant: must stay untouched
    evil.locks.add(TUE_3PM);
    const e = ev('reschedule', bookingId, { tenantId: 't_evil00001', tid: 't_evil00001', slotStart: WED_10AM, ...WHO });
    e.queryStringParameters = { tenantId: 't_evil00001' };
    e.headers['x-tenant-id'] = 't_evil00001';
    await rescheduleBooking(e, deps);
    // The reschedule above moved the booking to Wednesday, which is now the day it is booked for.
    await cancelBooking(ev('cancel', bookingId, { tenantId: 't_evil00001', ...WHO, bookedDay: '2026-10-07' }, { idem: 'idem-cancel-09' }), deps);
    expect(new Set(repoCalls)).toEqual(new Set([TENANT]));
    expect(evil.bookings[0]?.status).toBe('confirmed');
    expect(evil.bookings[0]?.start).toBe(TUE_3PM);
    expect(evil.locks.has(TUE_3PM)).toBe(true);
  });

  it("never lets tenant A's token see tenant B's booking: customers get 403, owners 404, B is never opened", async () => {
    const a = new LifecycleRepo(); const b = new LifecycleRepo();
    const { deps, repoCalls } = makeDeps({ [TENANT]: a, t_tenantb01: b });
    b.bookings.push({ bookingId: 'bk_b1', start: TUE_3PM, end: '2026-10-06T20:30:00.000Z', serviceId: 'cut', status: 'confirmed', customer: { name: 'Ada Obi' }, via: 'voice', createdAt: NOW.toISOString() });
    const asCustomer = await fails(cancelBooking(ev('cancel', 'bk_b1', WHO), deps));
    const asOwner = await fails(cancelBooking(ev('cancel', 'bk_b1', {}, { prn: 'owner', ch: 'dashboard' }), deps));
    expect(asCustomer.status).toBe(403);
    expect(asOwner.status).toBe(404);
    expect(b.bookings[0]?.status).toBe('confirmed');
    expect(new Set(repoCalls)).toEqual(new Set([TENANT]));
  });

  it('answers 501 with a natural line until the repo exposes the lifecycle store', async () => {
    const plain = new MemoryRepo();
    const { deps } = makeDeps({ [TENANT]: plain });
    expect(() => lifecycleOf(plain)).toThrowError(HttpError);
    const err = await fails(cancelBooking(ev('cancel', 'bk_1', {}, { prn: 'owner', ch: 'dashboard' }), deps));
    expect(err.status).toBe(501);
    expect(err.sayToCaller).toBeTruthy();
  });

  it('falls back to the request id when a token carries no call id, so a code only works for the request that issued it', async () => {
    // A token without a call id falls back to the request id, which differs on every request.
    const { deps, bookingId } = await seed();
    const mint = (rid: string): HttpEvent => {
      const token = mintTenantToken({ tid: TENANT, prn: 'customer-agent', ch: 'webchat' }, SECRET);
      return { headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-nocid-001' }, body: JSON.stringify(WHO), pathParameters: { bookingId }, requestContext: { requestId: rid } };
    };
    const first = parse(await rescheduleBooking({ ...mint('req-A'), body: JSON.stringify({ slotStart: WED_10AM, ...WHO }) }, deps));
    const reuse = await fails(cancelBooking({ ...mint('req-B'), body: JSON.stringify({ verificationCode: first.verificationCode }) }, deps));
    expect(reuse.status).toBe(403);
  });
});

// ---- DynamoDB implementation -------------------------------------------------------------------------------------------

type Cmd = { constructor: { name: string }; input: Record<string, any> };
function recordingDoc(reply: (c: Cmd) => unknown = () => ({})) {
  const sent: Cmd[] = [];
  const doc = { send: async (c: Cmd) => { sent.push(c); const r = reply(c); if (r instanceof Error) throw r; return r; } };
  return { doc: doc as never, sent };
}
const cancelledTx = (...codes: string[]) => Object.assign(new Error('tx'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) });
const stored = (over: Partial<StoredBooking> = {}): StoredBooking => ({
  bookingId: 'bk_1', start: TUE_3PM, end: '2026-10-06T20:30:00.000Z', serviceId: 'cut', status: 'confirmed',
  customer: { name: 'Ada Obi', phone: '+12145550123' }, via: 'voice', createdAt: '2026-10-02T15:00:00.000Z', ...over,
});
const keyOf = (i: any) => { const x = i.Put ?? i.Delete ?? i.Update ?? i.ConditionCheck; return `${(x.Item ?? x.Key).PK}|${(x.Item ?? x.Key).SK}`; };
const PK = 'TENANT#t_a1';

describe('ddbLifecycleStore', () => {
  const move = (over: Partial<RescheduleInput> = {}): RescheduleInput => ({
    booking: stored(), moved: stored({ start: WED_10AM, end: '2026-10-07T15:30:00.000Z' }),
    oldIsos: [TUE_3PM, TUE_315], newIsos: [WED_10AM, WED_1015], idempotencyKey: 'idem-move-01', response: { ok: true }, at: NOW.toISOString(), ...over,
  });

  it('reschedules in ONE transaction: idempotency record, old booking deleted, new booking put, old locks deleted, new locks put', async () => {
    const { doc, sent } = recordingDoc();
    await ddbLifecycleStore(doc, 'tbl', 't_a1').reschedule(move());
    expect(sent.map((c) => c.constructor.name)).toEqual(['TransactWriteCommand']);
    const items = sent[0]!.input.TransactItems as any[];
    expect(items.map(keyOf)).toEqual([
      `${PK}|IDEMP#reschedule:bk_1:idem-move-01`,
      `${PK}|BOOKING#${TUE_3PM}#bk_1`,
      `${PK}|BOOKING#${WED_10AM}#bk_1`,
      `${PK}|SLOT#default#${TUE_3PM}`, `${PK}|SLOT#default#${TUE_315}`,
      `${PK}|SLOT#default#${WED_10AM}`, `${PK}|SLOT#default#${WED_1015}`,
    ]);
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Delete', 'Put', 'Delete', 'Delete', 'Put', 'Put']);
    expect(new Set(items.map(keyOf)).size).toBe(items.length); // DynamoDB refuses two operations on one item
    expect(items.every((i) => (i.Put ?? i.Delete).TableName === 'tbl')).toBe(true);
    // The new booking item carries the moved record and the by-id index keys, and nothing from the old keys.
    expect(items[2].Put.Item).toMatchObject({ PK, SK: `BOOKING#${WED_10AM}#bk_1`, GSI1PK: 'TENANT#t_a1#BID', GSI1SK: 'bk_1', start: WED_10AM, status: 'confirmed' });
    expect(items[2].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[1].Delete.ConditionExpression).toMatch(/attribute_exists\(PK\)/);
    expect(items[0].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[0].Put.Item.response).toEqual({ ok: true });
    expect(items[0].Put.Item.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 86_400);
    // Locks: only deleted or written when they belong to nobody or to this booking.
    for (const i of [items[3], items[4]]) expect(i.Delete.ConditionExpression).toBe('attribute_not_exists(PK) OR bookingId = :bid');
    for (const i of [items[5], items[6]]) { expect(i.Put.ConditionExpression).toBe('attribute_not_exists(PK) OR bookingId = :bid'); expect(i.Put.Item.bookingId).toBe('bk_1'); }
  });

  it('touches only the locks that differ when the old and new times overlap', async () => {
    const { doc, sent } = recordingDoc();
    await ddbLifecycleStore(doc, 'tbl', 't_a1').reschedule(move({
      moved: stored({ start: TUE_315, end: '2026-10-06T20:45:00.000Z' }), newIsos: [TUE_315, '2026-10-06T20:30:00.000Z'],
    }));
    const items = sent[0]!.input.TransactItems as any[];
    expect(items.map(keyOf).filter((k) => k.includes('SLOT'))).toEqual([`${PK}|SLOT#default#${TUE_3PM}`, `${PK}|SLOT#default#2026-10-06T20:30:00.000Z`]);
    expect(new Set(items.map(keyOf)).size).toBe(items.length);
  });

  it('maps the cancellation reasons: replay, booking changed, slot taken; anything else passes through', async () => {
    const run = (...codes: string[]) => ddbLifecycleStore(recordingDoc(() => cancelledTx(...codes)).doc, 'tbl', 't_a1').reschedule(move());
    const N = 'None'; const F = 'ConditionalCheckFailed';
    await expect(run(F, N, N, N, N, N, N)).rejects.toBeInstanceOf(IdempotentReplay);
    await expect(run(N, F, N, N, N, N, N)).rejects.toBeInstanceOf(BookingChangedError);
    await expect(run(N, N, F, N, N, N, N)).rejects.toBeInstanceOf(BookingChangedError);
    await expect(run(N, N, N, F, N, N, N)).rejects.toBeInstanceOf(BookingChangedError);
    await expect(run(N, N, N, N, N, F, N)).rejects.toBeInstanceOf(SlotTakenError);
    await expect(run(N, N, N, N, N, N, F)).rejects.toBeInstanceOf(SlotTakenError);
    await expect(run(N, N, N, N, N, 'ThrottlingError', N)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
  });

  it('cancels in ONE transaction: flip the booking to cancelled and delete its locks', async () => {
    const { doc, sent } = recordingDoc();
    await ddbLifecycleStore(doc, 'tbl', 't_a1').cancel({ booking: stored(), isos: [TUE_3PM, TUE_315], reason: 'busy', at: NOW.toISOString() });
    expect(sent.map((c) => c.constructor.name)).toEqual(['TransactWriteCommand']);
    const items = sent[0]!.input.TransactItems as any[];
    expect(items.map(keyOf)).toEqual([`${PK}|BOOKING#${TUE_3PM}#bk_1`, `${PK}|SLOT#default#${TUE_3PM}`, `${PK}|SLOT#default#${TUE_315}`]);
    const upd = items[0].Update;
    expect(upd.ConditionExpression).toBe('attribute_exists(PK) AND #s = :confirmed');
    expect(upd.UpdateExpression).toMatch(/SET #s = :cancelled/);
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':cancelled': 'cancelled', ':confirmed': 'confirmed', ':at': NOW.toISOString(), ':r': 'busy' });
    expect(items[1].Delete.ConditionExpression).toBe('attribute_not_exists(PK) OR bookingId = :bid');
  });

  it('leaves the reason out of the update when there is none, and reports a lost race as BookingChangedError', async () => {
    const ok = recordingDoc();
    await ddbLifecycleStore(ok.doc, 'tbl', 't_a1').cancel({ booking: stored(), isos: [TUE_3PM], at: NOW.toISOString() });
    const upd = (ok.sent[0]!.input.TransactItems as any[])[0].Update;
    expect(upd.UpdateExpression).not.toMatch(/cancelReason/);
    expect(upd.ExpressionAttributeValues).not.toHaveProperty(':r');
    const lost = ddbLifecycleStore(recordingDoc(() => cancelledTx('ConditionalCheckFailed', 'None')).doc, 'tbl', 't_a1');
    await expect(lost.cancel({ booking: stored(), isos: [TUE_3PM], at: NOW.toISOString() })).rejects.toBeInstanceOf(BookingChangedError);
  });

  it('reads a booking by id through the by-id index, strips key attributes, and refuses another tenant partition', async () => {
    const row = { PK, SK: `BOOKING#${TUE_3PM}#bk_1`, GSI1PK: 'TENANT#t_a1#BID', GSI1SK: 'bk_1', ...stored() };
    const { doc, sent } = recordingDoc(() => ({ Items: [row] }));
    const got = await ddbLifecycleStore(doc, 'tbl', 't_a1').getBooking('bk_1');
    expect(got).toEqual(stored());
    expect(sent[0]!.constructor.name).toBe('QueryCommand');
    expect(sent[0]!.input).toMatchObject({ IndexName: 'GSI1', ExpressionAttributeValues: { ':p': 'TENANT#t_a1#BID', ':b': 'bk_1' } });
    const stray = recordingDoc(() => ({ Items: [{ ...row, PK: 'TENANT#t_other' }] }));
    expect(await ddbLifecycleStore(stray.doc, 'tbl', 't_a1').getBooking('bk_1')).toBeUndefined();
    expect(await ddbLifecycleStore(recordingDoc(() => ({ Items: [] })).doc, 'tbl', 't_a1').getBooking('bk_1')).toBeUndefined();
  });

  it('stores verification records with a hashed call key and TTL, and counts misses atomically', async () => {
    const put = recordingDoc();
    const store = ddbLifecycleStore(put.doc, 'tbl', 't_a1');
    const rec: VerificationRecord = { callKey: callKeyOf('call-1'), bookingId: 'bk_1', codeHash: 'h', issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + VERIFICATION_TTL_MS).toISOString(), attempts: 0 };
    await store.putVerification(rec);
    expect(put.sent[0]!.constructor.name).toBe('PutCommand');
    expect(put.sent[0]!.input.Item).toMatchObject({ PK, SK: `VERIFY#${callKeyOf('call-1')}#bk_1`, codeHash: 'h', attempts: 0 });
    expect(put.sent[0]!.input.Item.ttl).toBeGreaterThan(Math.floor(Date.parse(rec.expiresAt) / 1000));
    expect(JSON.stringify(put.sent[0]!.input)).not.toContain('call-1');

    const bump = recordingDoc(() => ({ Attributes: { attempts: 3 } }));
    expect(await ddbLifecycleStore(bump.doc, 'tbl', 't_a1').recordFailedAttempt(callKeyOf('call-1'), 'bk_1', NOW)).toBe(3);
    expect(bump.sent[0]!.constructor.name).toBe('UpdateCommand');
    expect(bump.sent[0]!.input.UpdateExpression).toMatch(/ADD attempts :one/);
    expect(bump.sent[0]!.input.ConditionExpression).toMatch(/attribute_not_exists\(PK\) OR expiresAt > :now/);

    // A stale (expired) record restarts the window instead of carrying old misses forward.
    let n = 0;
    const stale = recordingDoc(() => (n++ === 0 ? Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }) : {}));
    expect(await ddbLifecycleStore(stale.doc, 'tbl', 't_a1').recordFailedAttempt(callKeyOf('call-1'), 'bk_1', NOW)).toBe(1);
    expect(stale.sent.map((c) => c.constructor.name)).toEqual(['UpdateCommand', 'PutCommand']);
    expect(stale.sent[1]!.input.Item).toMatchObject({ attempts: 1 });
  });

  it('reads verification records and replay answers consistently, and addresses only its own tenant partition', async () => {
    const seen: string[] = [];
    const { doc, sent } = recordingDoc((c) => {
      const i = c.input;
      if (i.Key) seen.push(i.Key.PK);
      if (i.Item) seen.push(i.Item.PK);
      if (i.ExpressionAttributeValues?.[':p']) seen.push(String(i.ExpressionAttributeValues[':p']).replace('#BID', ''));
      for (const t of i.TransactItems ?? []) seen.push((t.Put ?? t.Delete ?? t.Update).Item?.PK ?? (t.Put ?? t.Delete ?? t.Update).Key.PK);
      return c.constructor.name === 'UpdateCommand' ? { Attributes: { attempts: 1 } } : { Items: [] };
    });
    const store = ddbLifecycleStore(doc, 'tbl', 't_zz9');
    await store.getBooking('bk_1'); await store.getVerification('k', 'bk_1'); await store.getIdempotent('bk_1', 'idem-0001');
    await store.putVerification({ callKey: 'k', bookingId: 'bk_1', expiresAt: NOW.toISOString(), attempts: 0 });
    await store.recordFailedAttempt('k', 'bk_1', NOW);
    await store.reschedule(move()); await store.cancel({ booking: stored(), isos: [TUE_3PM], at: NOW.toISOString() });
    expect(seen.length).toBeGreaterThan(8);
    expect(new Set(seen)).toEqual(new Set(['TENANT#t_zz9']));
    for (const c of sent.filter((x) => x.constructor.name === 'GetCommand')) expect(c.input.ConsistentRead).toBe(true);
  });

  it('refuses a tenant id that could widen the IAM policy or break key parsing', () => {
    for (const bad of ['', 'a#b', 'a b', '*', 'a'.repeat(65)]) expect(() => ddbLifecycleStore(recordingDoc().doc, 'tbl', bad)).toThrow();
  });
});

// ---- caller-facing copy ------------------------------------------------------------------------------------------------

describe('what the caller hears', () => {
  it('every error line is human: no style errors or warnings, voice or chat', () => {
    const lines = [...Object.values(LIFECYCLE_ERRORS), ...Object.values(VERIFICATION_ERRORS)].map((e) => e.sayToCaller);
    expect(lines.length).toBeGreaterThanOrEqual(12);
    for (const line of lines) {
      expect(checkReply(line, { channel: 'voice' }), line).toEqual([]);
      expect(checkReply(line, { channel: 'chat' }), line).toEqual([]);
    }
  });

  it('every line returned by the handlers in these tests passes as well', () => {
    for (const line of said) {
      expect(checkReply(line, { channel: 'voice' }), line).toEqual([]);
      expect(checkReply(line, { channel: 'chat' }), line).toEqual([]);
    }
  });

  it('asks for the name and the day when verification is missing', () => {
    expect(VERIFICATION_ERRORS.required.sayToCaller).toMatch(/name/i);
    expect(VERIFICATION_ERRORS.required.sayToCaller).toMatch(/day/i);
    expect(VERIFICATION_ERRORS.required.sayToCaller).not.toMatch(/code/i); // nothing is texted: ADR-0005 rules SMS out
  });
});
