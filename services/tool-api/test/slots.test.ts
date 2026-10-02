import { describe, expect, it } from 'vitest';
import { isWithinHours, openSlots, slotInstants, spoken } from '../src/lib/slots.js';
import { HOURS } from './fakes.js';

// 2026-10-06 is a Tuesday. Chicago is UTC-5 (CDT) on that date, so 15:00 local = 20:00Z.
const TUE_3PM = new Date('2026-10-06T20:00:00.000Z');
const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

describe('business hours in tenant timezone', () => {
  it('accepts a slot inside hours', () => expect(isWithinHours(HOURS, TUE_3PM, plus(TUE_3PM, 30))).toBe(true));
  it('rejects a slot that runs past close', () => expect(isWithinHours(HOURS, plus(TUE_3PM, 105), plus(TUE_3PM, 135))).toBe(false));
  it('accepts a slot ending exactly at close', () => expect(isWithinHours(HOURS, plus(TUE_3PM, 90), plus(TUE_3PM, 120))).toBe(true));
  it('rejects Sunday', () => expect(isWithinHours(HOURS, new Date('2026-10-04T20:00:00Z'), new Date('2026-10-04T20:30:00Z'))).toBe(false));
  it('rejects closed dates', () => {
    expect(isWithinHours({ ...HOURS, closedDates: ['2026-10-06'] }, TUE_3PM, plus(TUE_3PM, 30))).toBe(false);
  });
});

describe('slot locks', () => {
  it('covers every 15-minute increment of the booking', () => {
    expect(slotInstants(TUE_3PM, 40)).toEqual([
      '2026-10-06T20:00:00.000Z', '2026-10-06T20:15:00.000Z', '2026-10-06T20:30:00.000Z',
    ]);
  });
  it('refuses unaligned starts', () => expect(() => slotInstants(plus(TUE_3PM, 7), 30)).toThrow());
});

describe('open slots', () => {
  it('skips locked instants and speaks local time', () => {
    const slots = openSlots({
      hours: HOURS, from: TUE_3PM, to: plus(TUE_3PM, 120), durationMin: 30,
      locked: new Set(['2026-10-06T20:00:00.000Z']), maxResults: 2,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-10-06T20:15:00.000Z', '2026-10-06T20:30:00.000Z']);
    expect(spoken(TUE_3PM, 'America/Chicago')).toBe('Tuesday at 3 PM');
  });
  it('speaks relative days like a person', () => {
    const mon = new Date('2026-10-05T15:00:00Z'); // Monday 10 AM Chicago
    expect(spoken(TUE_3PM, 'America/Chicago', mon)).toBe('tomorrow at 3 PM');
    expect(spoken(new Date('2026-10-05T19:30:00Z'), 'America/Chicago', mon)).toBe('today at 2:30 PM');
    expect(spoken(new Date('2026-10-13T20:00:00Z'), 'America/Chicago', mon)).toBe('Tuesday, October 13 at 3 PM');
  });
});
