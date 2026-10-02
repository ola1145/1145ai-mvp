/** Pure scheduling helpers. No I/O. Timezone math via Intl so there is no date library dependency. */
export interface WeeklyWindow { day: number; open: string; close: string } // day 0 = Sunday, "HH:MM"
export interface BusinessHours { timezone: string; weekly: WeeklyWindow[]; closedDates?: string[] }

export const SLOT_GRANULARITY_MIN = 15;
const MS_MIN = 60_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts { weekday: number; minutes: number; ymd: string }

export function localParts(d: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekday: WEEKDAYS[get('weekday')] ?? -1,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const hhmm = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** True when [start, end) sits fully inside one opening window on one local day and the date is not closed. */
export function isWithinHours(hours: BusinessHours, start: Date, end: Date): boolean {
  if (end <= start) return false;
  const s = localParts(start, hours.timezone);
  const e = localParts(new Date(end.getTime() - MS_MIN), hours.timezone); // last minute of the booking
  if (s.ymd !== e.ymd) return false;
  if (hours.closedDates?.includes(s.ymd)) return false;
  const endMinutes = e.minutes + 1;
  return hours.weekly.some((w) => w.day === s.weekday && hhmm(w.open) <= s.minutes && endMinutes <= hhmm(w.close));
}

/** Slot-lock instants covered by a booking. Each becomes one conditional write. */
export function slotInstants(start: Date, durationMin: number, granularityMin = SLOT_GRANULARITY_MIN): string[] {
  if (start.getTime() % (granularityMin * MS_MIN) !== 0) throw new Error('start not aligned to slot granularity');
  const count = Math.ceil(durationMin / granularityMin);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * granularityMin * MS_MIN).toISOString());
}

export function alignUp(d: Date, granularityMin = SLOT_GRANULARITY_MIN): Date {
  const g = granularityMin * MS_MIN;
  return new Date(Math.ceil(d.getTime() / g) * g);
}

export function spoken(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = get('minute');
  const time = minute === '00' ? `${get('hour')} ${get('dayPeriod')}` : `${get('hour')}:${minute} ${get('dayPeriod')}`;
  return `${get('weekday')} at ${time}`;
}

/** Candidate starts in [from, to) that fit business hours and do not overlap a locked instant. */
export function openSlots(params: {
  hours: BusinessHours; from: Date; to: Date; durationMin: number; locked: ReadonlySet<string>;
  maxResults?: number; notBefore?: Date;
}): Array<{ start: string; end: string; spoken: string }> {
  const { hours, durationMin, locked } = params;
  const max = params.maxResults ?? 5;
  const out: Array<{ start: string; end: string; spoken: string }> = [];
  const floor = params.notBefore && params.notBefore > params.from ? params.notBefore : params.from;
  let cursor = alignUp(floor);
  const step = SLOT_GRANULARITY_MIN * MS_MIN;
  for (let i = 0; i < 2000 && cursor < params.to && out.length < max; i++, cursor = new Date(cursor.getTime() + step)) {
    const end = new Date(cursor.getTime() + durationMin * MS_MIN);
    if (end > params.to || !isWithinHours(hours, cursor, end)) continue;
    if (slotInstants(cursor, durationMin).some((iso) => locked.has(iso))) continue;
    out.push({ start: cursor.toISOString(), end: end.toISOString(), spoken: spoken(cursor, hours.timezone) });
  }
  return out;
}
