/** Local calendar date (YYYY-MM-DD) of an instant in an IANA zone. */
export function localDate(at: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** The local date after `date` (YYYY-MM-DD). Calendar arithmetic only, so DST never skips or repeats a day. */
export function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** UTC offset in minutes of `timeZone` at the given instant (negative west of Greenwich). */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** ISO instant (UTC) for a local wall-clock time on a local date in `timeZone`. */
export function zonedToIso(date: string, hour: number, minute: number, timeZone: string): string {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const first = new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60000);
  const second = new Date(guess.getTime() - offsetMinutes(first, timeZone) * 60000);
  return second.toISOString();
}

/** True when `iso` falls on the local day after `now` in `timeZone`. */
export function isTomorrow(iso: string, now: Date, timeZone: string): boolean {
  return localDate(new Date(iso), timeZone) === nextDate(localDate(now, timeZone));
}
