import { describe, expect, it } from 'vitest';
import { isQuietNow, planDelivery, DEFAULT_ROUTES } from '../src/routing.js';

const noon = new Date('2026-10-02T16:00:00Z'); // noon in New York (EDT)
const lateNight = new Date('2026-10-03T05:30:00Z'); // 1:30 am in New York
const NY = 'America/New_York';

describe('preference routing per event type', () => {
  it('uses sensible defaults for each event type', () => {
    const booking = planDelivery('booking.created', {}, noon, NY, false);
    expect(booking).toMatchObject({ telegram: { silent: false }, email: true, push: true, call: false });

    const msg = planDelivery('message.taken', {}, noon, NY, false);
    expect(msg).toMatchObject({ telegram: { silent: false }, push: true, call: false });

    const usage = planDelivery('usage.recorded', {}, noon, NY, false);
    expect(usage).toMatchObject({ telegram: { silent: false }, email: true, push: false });

    expect(Object.keys(DEFAULT_ROUTES).sort()).toEqual([
      'booking.cancelled', 'booking.created', 'handoff.requested', 'message.taken',
      'tenant.provisioned', 'tenant.state_changed', 'usage.recorded',
    ]);
  });

  it('lets the owner pick channels per event type', () => {
    const prefs = { events: { 'booking.created': ['email'], 'message.taken': [] } } as const;
    expect(planDelivery('booking.created', prefs as never, noon, NY, false)).toMatchObject({ telegram: null, email: true, push: false });
    expect(planDelivery('message.taken', prefs as never, noon, NY, false)).toMatchObject({ telegram: null, email: false, push: false });
    // other event types keep their defaults
    expect(planDelivery('booking.cancelled', prefs as never, noon, NY, false).telegram).not.toBeNull();
  });

  it('never routes an event type it does not know', () => {
    expect(planDelivery('call.ended' as never, {}, noon, NY, false)).toMatchObject({ telegram: null, email: false, push: false, call: false });
  });
});

describe('quiet hours', () => {
  const prefs = { quietHours: { start: '22:00', end: '07:00' } };

  it('knows when it is quiet in the tenant timezone, across midnight', () => {
    expect(isQuietNow(lateNight, NY, prefs.quietHours)).toBe(true);
    expect(isQuietNow(noon, NY, prefs.quietHours)).toBe(false);
    // 05:30 UTC is 22:30 the evening before in Los Angeles: also quiet
    expect(isQuietNow(lateNight, 'America/Los_Angeles', prefs.quietHours)).toBe(true);
    // 05:30 UTC is 15:30 in Sydney: not quiet
    expect(isQuietNow(lateNight, 'Australia/Sydney', prefs.quietHours)).toBe(false);
  });

  it('handles a same-day window and no window', () => {
    expect(isQuietNow(noon, NY, { start: '12:00', end: '13:00' })).toBe(true);
    expect(isQuietNow(noon, NY, { start: '13:00', end: '14:00' })).toBe(false);
    expect(isQuietNow(noon, NY, null)).toBe(false);
    expect(isQuietNow(noon, NY, undefined)).toBe(false);
    expect(isQuietNow(noon, NY, { start: 'bogus', end: '07:00' })).toBe(false);
  });

  it('keeps telegram and email but silences it, and skips push, during quiet hours', () => {
    const plan = planDelivery('booking.created', prefs, lateNight, NY, false);
    expect(plan.quiet).toBe(true);
    expect(plan.telegram).toEqual({ silent: true });
    expect(plan.email).toBe(true);
    expect(plan.push).toBe(false);
  });
});

describe('urgent call', () => {
  it('only an urgent handoff can place a call', () => {
    expect(planDelivery('handoff.requested', {}, noon, NY, true).call).toBe(true);
    expect(planDelivery('handoff.requested', {}, noon, NY, false).call).toBe(false);
    for (const t of ['booking.created', 'booking.cancelled', 'message.taken', 'usage.recorded', 'tenant.state_changed', 'tenant.provisioned'] as const) {
      expect(planDelivery(t, {}, noon, NY, true).call).toBe(false);
    }
  });

  it('urgent calls go through quiet hours unless the owner turned that off', () => {
    const quiet = { quietHours: { start: '22:00', end: '07:00' } };
    expect(planDelivery('handoff.requested', quiet, lateNight, NY, true).call).toBe(true);
    expect(planDelivery('handoff.requested', { ...quiet, urgentCallInQuietHours: false }, lateNight, NY, true).call).toBe(false);
  });

  it('the owner can switch urgent calls off entirely', () => {
    expect(planDelivery('handoff.requested', { urgentCall: false }, noon, NY, true).call).toBe(false);
  });

  it('an urgent handoff is never silent, even at night', () => {
    const plan = planDelivery('handoff.requested', { quietHours: { start: '22:00', end: '07:00' } }, lateNight, NY, true);
    expect(plan.telegram).toEqual({ silent: false });
    expect(plan.push).toBe(true);
  });
});
