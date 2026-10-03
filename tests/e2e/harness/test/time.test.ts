import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTomorrow, localDate, nextDate, zonedToIso } from '../time.ts';

test('localDate respects the zone, not UTC', () => {
  assert.equal(localDate(new Date('2026-10-04T02:00:00Z'), 'America/Chicago'), '2026-10-03');
});
test('nextDate rolls month and year', () => {
  assert.equal(nextDate('2026-10-31'), '2026-11-01');
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
});
test('zonedToIso handles CDT and CST', () => {
  assert.equal(zonedToIso('2026-10-04', 15, 0, 'America/Chicago'), '2026-10-04T20:00:00.000Z');
  assert.equal(zonedToIso('2026-12-04', 15, 0, 'America/Chicago'), '2026-12-04T21:00:00.000Z');
});
test('isTomorrow judges the local day', () => {
  const now = new Date('2026-10-03T15:00:00Z');
  assert.equal(isTomorrow('2026-10-04T20:00:00Z', now, 'America/Chicago'), true);
  assert.equal(isTomorrow('2026-10-03T20:00:00Z', now, 'America/Chicago'), false);
  assert.equal(isTomorrow('2026-10-05T01:00:00Z', now, 'America/Chicago'), true); // 8pm Oct 4 local
});
