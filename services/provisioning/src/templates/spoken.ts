/**
 * Turns structured profile data into the words a person at a front desk would say. The rendered prompt uses these
 * forms so the model repeats "Tuesday through Friday, nine to six" instead of "Tue 09:00-18:00".
 */
export interface DayHours { day: number; open: string; close: string }
export interface BusinessHours { timezone: string; weekly: DayHours[]; closedDates?: string[] }

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth',
  'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** People read a week Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** 0..999,999 in words, the way it's said aloud ("a hundred and twenty", "forty-five"). */
export function numberWords(n: number, leading = true): string {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${h === 1 && leading ? 'a' : ONES[h]} hundred${rest ? ` and ${numberWords(rest)}` : ''}`;
  }
  const t = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = `${t === 1 && leading ? 'a' : numberWords(t, false)} thousand`;
  if (!rest) return head;
  return `${head}${rest < 100 ? ' and ' : ' '}${numberWords(rest, false)}`;
}

function parseClock(hhmm: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid time "${hhmm}"`);
  return { h: Number(m[1]) % 24, m: Number(m[2]) };
}

function clockWords(h: number, m: number): string {
  if (m === 0 && h === 12) return 'noon';
  if (m === 0 && h === 0) return 'midnight';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (m === 0) return ONES[h12]!;
  return `${ONES[h12]} ${m < 10 ? `oh ${ONES[m]}` : numberWords(m)}`;
}

/** "09:30" -> "nine thirty", "12:00" -> "noon". */
export function spokenTime(hhmm: string): string {
  const { h, m } = parseClock(hhmm);
  return clockWords(h, m);
}

function partOfDay(h: number): string {
  if (h < 12) return 'in the morning';
  if (h < 17) return 'in the afternoon';
  if (h < 21) return 'in the evening';
  return 'at night';
}

/**
 * "nine to six" when nobody could mishear it; otherwise "seven in the morning to seven in the evening".
 * A morning open with an earlier-on-the-clock afternoon close, or an afternoon open closing by nine, is unambiguous.
 */
export function spokenRange(open: string, close: string): string {
  const o = parseClock(open);
  const c = parseClock(close);
  const oWords = clockWords(o.h, o.m);
  const cWords = clockWords(c.h, c.m);
  const oNamed = o.m === 0 && (o.h === 12 || o.h === 0);
  const cNamed = c.m === 0 && (c.h === 12 || c.h === 0);
  const plain =
    (o.h >= 7 && o.h <= 11 && c.h >= 12 && c.h <= 20 && (c.h === 12 || c.h - 12 < o.h)) ||
    (o.h >= 7 && o.h <= 11 && c.h > o.h && c.h <= 11) ||
    (o.h >= 12 && o.h <= 16 && c.h > o.h && c.h <= 21);
  if (plain) return `${oWords} to ${cWords}`;
  return `${oNamed ? oWords : `${oWords} ${partOfDay(o.h)}`} to ${cNamed ? cWords : `${cWords} ${partOfDay(c.h)}`}`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function dayRun(days: number[]): string {
  if (days.length === 2 && days[0] === 6 && days[1] === 0) return 'weekends';
  if (days.length === 1) return DAY_NAMES[days[0]!]!;
  if (days.length === 2) return `${DAY_NAMES[days[0]!]} and ${DAY_NAMES[days[1]!]}`;
  return `${DAY_NAMES[days[0]!]} through ${DAY_NAMES[days[days.length - 1]!]}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2026-12-25" -> "December twenty-fifth". */
export function spokenDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) throw new Error(`invalid date "${iso}"`);
  return `${MONTHS[Number(m[2]) - 1]} ${ORDINALS[Number(m[3])]}`;
}

/**
 * Weekly hours as one or two short spoken sentences, grouping runs of days with the same hours.
 * `today` (YYYY-MM-DD, tenant local) drops closed dates that have already passed. Returns '' when no hours are set.
 */
export function spokenHours(hours: BusinessHours, today?: string): string {
  if (!hours.weekly.length) return '';
  const byDay = new Map<number, string>();
  for (const d of WEEK) {
    const ranges = hours.weekly
      .filter((w) => w.day === d)
      .sort((a, b) => a.open.localeCompare(b.open))
      .map((w) => spokenRange(w.open, w.close));
    byDay.set(d, ranges.length ? ranges.join(' and ') : '');
  }
  const key = (d: number) => byDay.get(d)!;

  let start = 0;
  for (let i = 0; i < WEEK.length; i++) {
    if (key(WEEK[i]!) !== key(WEEK[(i + WEEK.length - 1) % WEEK.length]!)) { start = i; break; }
  }
  const order = [...WEEK.slice(start), ...WEEK.slice(0, start)];
  const runs: Array<{ days: number[]; hours: string }> = [];
  for (const d of order) {
    const last = runs[runs.length - 1];
    if (last && last.hours === key(d)) last.days.push(d); else runs.push({ days: [d], hours: key(d) });
  }

  const parts: string[] = [];
  if (runs.length === 1) parts.push(`Every day, ${runs[0]!.hours}.`);
  else for (const r of runs) if (r.hours) parts.push(`${cap(dayRun(r.days))}, ${r.hours}.`);
  const closed = runs.filter((r) => !r.hours).map((r) => dayRun(r.days));
  if (closed.length) parts.push(`Closed ${joinAnd(closed)}.`);

  const upcoming = (hours.closedDates ?? []).filter((d) => !today || d >= today).sort();
  if (upcoming.length) parts.push(`Also closed ${joinAnd(upcoming.map(spokenDate))}.`);
  return parts.join(' ');
}

/** 3500 -> "thirty-five dollars", 2550 -> "twenty-five fifty", 0 -> "free". */
export function spokenPrice(cents: number): string {
  const c = Math.round(cents);
  if (c <= 0) return 'free';
  const dollars = Math.floor(c / 100);
  const rest = c % 100;
  if (!dollars) return `${numberWords(rest)} cents`;
  if (!rest) return dollars === 1 ? 'a dollar' : `${numberWords(dollars)} dollars`;
  return `${numberWords(dollars)} ${rest < 10 ? `oh ${ONES[rest]}` : numberWords(rest)}`;
}

/** 30 -> "half an hour", 90 -> "an hour and a half", 45 -> "forty-five minutes". */
export function spokenDuration(min: number): string {
  const m = Math.round(min);
  if (m < 60) return m === 30 ? 'half an hour' : `${numberWords(m)} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hours = h === 1 ? 'an hour' : `${numberWords(h)} hours`;
  if (!rest) return hours;
  if (rest === 30) return h === 1 ? 'an hour and a half' : `${numberWords(h)} and a half hours`;
  return `${hours} and ${spokenDuration(rest)}`;
}
