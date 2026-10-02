import { describe, expect, it } from 'vitest';
import { createBooking } from '../src/handlers/create-booking.js';
import { checkAvailability } from '../src/handlers/check-availability.js';
import { makeDeps, MemoryRepo, voiceEvent } from './fakes.js';

const SLOT = '2026-10-06T20:00:00.000Z';

describe('createBooking', () => {
  it('books, returns a caller-safe line, and publishes booking.created', async () => {
    const repo = new MemoryRepo();
    const { deps, published } = makeDeps({ t_tenanta01: repo });
    const res = await createBooking(voiceEvent({ slotStart: SLOT, serviceId: 'cut', customer: { name: 'Ada Obi' } }), deps);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).sayToCaller).toMatch(/Tuesday at 3 PM/);
    expect(published.map((e) => e.type)).toEqual(['booking.created']);
    expect(repo.bookings[0]?.customer.phone).toBe('+12145550123');
  });

  it('returns 409 when an overlapping slot is already locked (double-booking guard)', async () => {
    const repo = new MemoryRepo();
    const { deps } = makeDeps({ t_tenanta01: repo });
    await createBooking(voiceEvent({ slotStart: SLOT, serviceId: 'cut', customer: { name: 'A' } }, { idem: 'idem-aaaa1' }), deps);
    const overlap = '2026-10-06T20:15:00.000Z';
    await expect(createBooking(voiceEvent({ slotStart: overlap, serviceId: 'cut', customer: { name: 'B' } }, { idem: 'idem-bbbb2' }), deps))
      .rejects.toMatchObject({ status: 409, code: 'slot_taken' });
  });

  it('replays the stored response for a repeated idempotency key without a second event', async () => {
    const repo = new MemoryRepo();
    const { deps, published } = makeDeps({ t_tenanta01: repo });
    const ev = voiceEvent({ slotStart: SLOT, serviceId: 'cut', customer: { name: 'A' } });
    const first = await createBooking(ev, deps);
    const second = await createBooking(ev, deps);
    expect(second.body).toBe(first.body);
    expect(published).toHaveLength(1);
  });

  it('ignores any tenantId or phone the model puts in the body', async () => {
    const a = new MemoryRepo(); const evil = new MemoryRepo();
    const { deps, repoCalls } = makeDeps({ t_tenanta01: a, t_evil00001: evil });
    await createBooking(voiceEvent({ tenantId: 't_evil00001', slotStart: SLOT, serviceId: 'cut', customer: { name: 'A', phone: '+19995550000' } }), deps);
    expect(repoCalls).toEqual(['t_tenanta01']);
    expect(evil.bookings).toHaveLength(0);
    expect(a.bookings[0]?.customer.phone).toBe('+12145550123');
  });

  it('rejects slots outside business hours with a spoken fallback', async () => {
    const { deps } = makeDeps({ t_tenanta01: new MemoryRepo() });
    await expect(createBooking(voiceEvent({ slotStart: '2026-10-04T20:00:00.000Z', serviceId: 'cut', customer: { name: 'A' } }), deps))
      .rejects.toMatchObject({ status: 422, code: 'outside_hours' });
  });
});

describe('checkAvailability', () => {
  it('lists open slots in the tenant timezone', async () => {
    const { deps } = makeDeps({ t_tenanta01: new MemoryRepo() });
    const res = await checkAvailability(voiceEvent({ dateFrom: SLOT, dateTo: '2026-10-06T22:00:00.000Z', maxResults: 3 }), deps);
    const body = JSON.parse(res.body);
    expect(body.timezone).toBe('America/Chicago');
    expect(body.slots[0].spoken).toBe('Tuesday at 3 PM');
  });
});
