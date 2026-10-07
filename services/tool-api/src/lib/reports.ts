/**
 * Read side for owner reports, the bookings list and the conversations list (issue T3).
 *
 * Everything here is a read of ONE tenant partition. The tenant id is never a parameter of a handler: it comes from
 * requireTenantContext, goes into repoFor, and is baked into the reader that comes back. Paging cursors carry only a sort
 * key, so a forged cursor can never point at another partition, and they are checked against the range being read.
 *
 * Time: callers talk in the owner's days ("this week"), not UTC. A date, or a date-time with no offset, is read in the
 * tenant's timezone. Only a date-time with an explicit Z or offset is taken as an exact instant.
 */
import { DynamoDBDocumentClient, GetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import { HttpError, json, type HttpResult } from './http.js';
import type { TenantRepo } from './repo.js';

// ---- lines the owner or the copilot reads --------------------------------------------------------------------

export const REPORT_LINES = {
  needDates: 'Which dates should I look at? Give me a start day and an end day.',
  badDates: "I couldn't make sense of those dates. Can you say them again?",
  backwards: 'That end date is before the start date. Can you give me the dates again?',
  tooWide: "That's a lot to pull up in one go. Could we look at a year or less?",
  badLimit: 'How many should I pull up? A whole number, like 10, works.',
  badCursor: 'I lost my place in that list. Want me to start again from the top?',
  notReady: "I can't pull those numbers up just yet.",
  unavailable: "I can't get to those numbers right now. Try me again in a minute.",
} as const;

const bad = (code: string, message: string, line: string) => new HttpError(400, code, message, line);

// ---- what a reader returns -----------------------------------------------------------------------------------

export type Sentiment = 'positive' | 'neutral' | 'negative';
export const SENTIMENTS: readonly Sentiment[] = ['positive', 'neutral', 'negative'];

export interface BookingRow {
  bookingId: string; start: string; end: string; serviceId: string; status: 'confirmed' | 'cancelled'; customerFirstName?: string;
}
export interface ConversationRow {
  conversationId: string; startedAt: string; channel?: string; summary?: string; sentiment?: Sentiment; durationSec?: number; hasTranscript: boolean;
}
export interface Page<T> { items: T[]; /** Opaque cursor for the next page. Absent on the last page. */ next?: string }

/** What a date range adds up to. `seconds` is billable seconds on conversations (voice and voice widget). */
export interface Tally {
  conversations: number; calls: number; seconds: number; sentiment: Record<Sentiment, number>;
  bookings: number; cancelledBookings: number; messages: number;
}

/**
 * Tenant-scoped reads. Expected to hang off TenantRepo as `repo.reports` (change request T3-1), so, like every other repo
 * method, it is implicitly scoped to one tenant. createDdbReports is the production implementation.
 */
export interface TenantReads {
  /** IANA timezone from the profile, else from business hours. Undefined when the tenant has neither. */
  timezone(): Promise<string | undefined>;
  /** Bookings whose appointment starts in [fromIso, toIso), oldest first. */
  listBookings(q: { fromIso: string; toIso: string; limit: number; after?: string }): Promise<Page<BookingRow>>;
  /** Newest first. */
  listConversations(q: { limit: number; after?: string }): Promise<Page<ConversationRow>>;
  /** Counts for conversations, bookings and taken messages that start in [fromIso, toIso). */
  tally(q: { fromIso: string; toIso: string }): Promise<Tally>;
}

export function reportsOf(repo: TenantRepo): TenantReads {
  const reads = (repo as TenantRepo & { reports?: TenantReads }).reports;
  if (!reads) throw new HttpError(501, 'not_implemented', 'repo has no report reads yet', REPORT_LINES.notReady);
  return reads;
}

/** Run reads, turning an unexpected failure into a line the owner can be told. Never leaks the error text. */
export async function guarded<T>(requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(JSON.stringify({ level: 'error', requestId, msg: 'report read failed', err: String(err) }));
    throw new HttpError(503, 'unavailable', 'could not read the data', REPORT_LINES.unavailable);
  }
}

// ---- timezones -----------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A tenant timezone we can actually use. Anything unknown becomes UTC rather than a failed report. */
export function safeTimezone(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return 'UTC';
  try { formatter(raw); return raw; } catch { return 'UTC'; }
}

/** Milliseconds `timeZone` is ahead of UTC at instant `t`. */
function offsetMs(t: number, timeZone: string): number {
  const v: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) if (p.type !== 'literal') v[p.type] = Number(p.value);
  return Date.UTC(v.year!, v.month! - 1, v.day!, (v.hour ?? 0) % 24, v.minute!, v.second!) - Math.floor(t / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads y-m-d h:mi:s.ms. Handles DST days of 23 and 25 hours. */
export function zonedInstant(y: number, m: number, d: number, h: number, mi: number, s: number, ms: number, timeZone: string): Date {
  const naive = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let t = naive - offsetMs(naive, timeZone);
  const second = offsetMs(t, timeZone);
  if (naive - t !== second) t = naive - second; // the guess crossed a DST edge
  return new Date(t);
}

interface Ymd { y: number; m: number; d: number }
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const EXACT_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/i;

function validDay(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function parseDay(raw: string): Ymd | undefined {
  const m = DAY_RE.exec(raw);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return validDay(y, mo, d) ? { y, m: mo, d } : undefined;
}
const nextDay = ({ y, m, d }: Ymd): Ymd => { const t = new Date(Date.UTC(y, m - 1, d + 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const midnight = (day: Ymd, tz: string) => zonedInstant(day.y, day.m, day.d, 0, 0, 0, 0, tz);

const MAX_SPAN_MS = 367 * 86_400_000;

/** [start, end) covering the whole of the local days `from` through `to` inclusive. Both are YYYY-MM-DD. */
export function dayRange(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) throw bad('invalid', 'from and to must be dates like 2026-10-05', REPORT_LINES.badDates);
  const start = midnight(a, timeZone);
  const end = midnight(nextDay(b), timeZone);
  if (end <= start) throw bad('bad_range', 'to is before from', REPORT_LINES.backwards);
  if (end.getTime() - start.getTime() > MAX_SPAN_MS) throw bad('range_too_wide', 'range is longer than a year', REPORT_LINES.tooWide);
  return { start, end };
}

/** Summary query: both dates required, YYYY-MM-DD, `to` is the last day included. */
export function summaryRange(q: Record<string, string | undefined>, timeZone: string) {
  const { from, to } = q;
  if (!from || !to) throw bad('invalid', 'from and to are required (YYYY-MM-DD)', REPORT_LINES.needDates);
  return { from, to, ...dayRange(from, to, timeZone) };
}

function parseInstant(raw: string, timeZone: string, edge: 'from' | 'to'): Date {
  const s = raw.trim();
  const day = parseDay(s);
  if (day) return edge === 'from' ? midnight(day, timeZone) : midnight(nextDay(day), timeZone); // a bare `to` day is included whole
  const local = LOCAL_RE.exec(s);
  if (local) {
    const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(local[i] ?? 0)) as [number, number, number, number, number, number];
    if (!validDay(y, mo, d) || h > 23 || mi > 59 || sec > 59) throw bad('invalid', 'not a valid date-time', REPORT_LINES.badDates);
    const frac = local[7] ? Number(local[7].slice(0, 3).padEnd(3, '0')) : 0;
    return zonedInstant(y, mo, d, h, mi, sec, frac, timeZone);
  }
  const exact = EXACT_RE.exec(s);
  if (exact) {
    const off = exact[2]!.toUpperCase();
    const fixed = off === 'Z' ? 'Z' : off.length === 3 ? `${off}:00` : off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
    const t = new Date(`${exact[1]!.replace(' ', 'T')}${fixed}`);
    if (!Number.isNaN(t.getTime())) return t;
  }
  throw bad('invalid', 'not a valid date or date-time', REPORT_LINES.badDates);
}

/** Bookings query: `from` and `to` are dates or date-times, [from, to). */
export function bookingRange(q: Record<string, string | undefined>, timeZone: string): { start: Date; end: Date } {
  if (!q.from || !q.to) throw bad('invalid', 'from and to are required', REPORT_LINES.needDates);
  const start = parseInstant(q.from, timeZone, 'from');
  const end = parseInstant(q.to, timeZone, 'to');
  if (end <= start) throw bad('bad_range', 'to must be after from', REPORT_LINES.backwards);
  if (end.getTime() - start.getTime() > MAX_SPAN_MS) throw bad('range_too_wide', 'range is longer than a year', REPORT_LINES.tooWide);
  return { start, end };
}

// ---- paging --------------------------------------------------------------------------------------------------

/** `limit` query parameter: absent means `def`, anything that is not a whole number >= 1 is a 400, too big is capped. */
export function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined || raw === '') return def;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) throw bad('invalid', 'limit must be a whole number of 1 or more', REPORT_LINES.badLimit);
  return Math.min(Number(raw), max);
}

const encodeCursor = (sk: string) => Buffer.from(sk, 'utf8').toString('base64url');

/** The sort key a cursor stands for, only if it is canonical and sits inside the range being read. Never a partition. */
function decodeCursor(cursor: string, shape: RegExp, lo: string, hi: string): string {
  const sk = /^[A-Za-z0-9_-]{1,512}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const ok = sk !== '' && encodeCursor(sk) === cursor && shape.test(sk) && sk >= lo && sk <= hi && !/[\u0000-\u001f]/.test(sk);
  if (!ok) throw bad('invalid_cursor', 'cursor is not valid for this list', REPORT_LINES.badCursor);
  return sk;
}

/** Array body stays as the contract says; the cursor travels in a header. */
export function pagedJson(rows: unknown, next: string | undefined): HttpResult {
  const res = json(200, rows);
  return next ? { ...res, headers: { ...res.headers, 'x-next-cursor': next } } : res;
}

// ---- DynamoDB implementation ---------------------------------------------------------------------------------

/** Same rule ddb-repo.ts applies before a tenant id becomes a key prefix. */
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const BOOKING = 'BOOKING#';
const CONV = 'CONV#';
const MSG = 'MSG#';
const BOOKING_SK = /^BOOKING#[^#]+#.+$/;
const CONV_SK = /^CONV#[^#]+#.+$/;

type Item = Record<string, unknown>;

/** Aliases every attribute (several common words are DynamoDB reserved words). */
function projection(paths: string[][]): Pick<QueryCommandInput, 'ProjectionExpression' | 'ExpressionAttributeNames'> {
  const names: Record<string, string> = {};
  const alias = new Map<string, string>();
  const ref = (n: string) => {
    let a = alias.get(n);
    if (!a) { a = `#p${alias.size}`; alias.set(n, a); names[a] = n; }
    return a;
  };
  return { ProjectionExpression: paths.map((p) => p.map(ref).join('.')).join(', '), ExpressionAttributeNames: names };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const seconds = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const cleanText = (v: unknown, max: number): string | undefined => {
  const s = str(v)?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max).trim();
  return s || undefined;
};
const sentimentOf = (v: unknown): Sentiment | undefined => SENTIMENTS.find((s) => s === v);

export function createDdbReports(doc: DynamoDBDocumentClient, tid: string, table: string = process.env.TABLE_NAME ?? 't1145'): TenantReads {
  if (!TENANT_ID.test(tid)) throw new Error('invalid tenant id');
  const pk = keys.tenantPk(tid);

  const getTimezone = async (sk: string) => {
    const r = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk, SK: sk }, ...projection([['timezone']]) }));
    return str(r.Item?.timezone);
  };

  /** Up to `want` items, following LastEvaluatedKey because a page can end early (1 MB cap). */
  async function collect(input: QueryCommandInput, want: number): Promise<Item[]> {
    const out: Item[] = [];
    let start = input.ExclusiveStartKey;
    do {
      const r = await doc.send(new QueryCommand({ ...input, Limit: want - out.length, ExclusiveStartKey: start }));
      out.push(...((r.Items ?? []) as Item[]));
      start = r.LastEvaluatedKey;
    } while (start && out.length < want);
    return out.slice(0, want);
  }

  /** Every page of a range, handed to `each` as it arrives. */
  async function walk(input: QueryCommandInput, each: (page: Item[], count: number) => void): Promise<void> {
    let start = input.ExclusiveStartKey;
    do {
      const r = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey: start }));
      each((r.Items ?? []) as Item[], r.Count ?? 0);
      start = r.LastEvaluatedKey;
    } while (start);
  }

  const between = (prefix: string, fromIso: string, toIso: string) => ({
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':pk': pk, ':a': `${prefix}${fromIso}`, ':b': `${prefix}${toIso}` },
  });

  return {
    async timezone() {
      return (await getTimezone(keys.profileSk())) ?? (await getTimezone(keys.hoursSk()));
    },

    async listBookings({ fromIso, toIso, limit, after }) {
      const lo = `${BOOKING}${fromIso}`;
      const hi = `${BOOKING}${toIso}`;
      const startSk = after ? decodeCursor(after, BOOKING_SK, lo, hi) : undefined;
      const rows = await collect({
        TableName: table, ...between(BOOKING, fromIso, toIso), ConsistentRead: true,
        ...projection([['SK'], ['bookingId'], ['start'], ['end'], ['serviceId'], ['status'], ['customer', 'name']]),
        ...(startSk ? { ExclusiveStartKey: { PK: pk, SK: startSk } } : {}),
      }, limit + 1); // one extra row says whether there is a next page
      const page = rows.slice(0, limit);
      const last = page[limit - 1];
      return {
        items: page.map(bookingRow),
        ...(rows.length > limit && last ? { next: encodeCursor(String(last.SK)) } : {}),
      };
    },

    async listConversations({ limit, after }) {
      const startSk = after ? decodeCursor(after, CONV_SK, CONV, `${CONV}￿`) : undefined;
      const rows = await collect({
        TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': pk, ':p': CONV }, ScanIndexForward: false, ConsistentRead: true,
        ...projection([['SK'], ['channel'], ['summary'], ['sentiment'], ['durationSec'], ['transcriptKey']]),
        ...(startSk ? { ExclusiveStartKey: { PK: pk, SK: startSk } } : {}),
      }, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[limit - 1];
      return {
        items: page.map(conversationRow),
        ...(rows.length > limit && last ? { next: encodeCursor(String(last.SK)) } : {}),
      };
    },

    async tally({ fromIso, toIso }) {
      const t: Tally = { conversations: 0, calls: 0, seconds: 0, sentiment: { positive: 0, neutral: 0, negative: 0 }, bookings: 0, cancelledBookings: 0, messages: 0 };
      await Promise.all([
        walk({ TableName: table, ...between(CONV, fromIso, toIso), ...projection([['channel'], ['sentiment'], ['durationSec'], ['billableSeconds']]) }, (items) => {
          for (const i of items) {
            t.conversations++;
            if (i.channel === 'voice') t.calls++;
            const s = sentimentOf(i.sentiment);
            if (s) t.sentiment[s]++;
            t.seconds += seconds(i.billableSeconds) ?? seconds(i.durationSec) ?? 0;
          }
        }),
        walk({ TableName: table, ...between(BOOKING, fromIso, toIso), ...projection([['status']]) }, (items) => {
          for (const i of items) {
            if (i.status === 'cancelled') t.cancelledBookings++;
            else t.bookings++;
          }
        }),
        walk({ TableName: table, ...between(MSG, fromIso, toIso), Select: 'COUNT' }, (_items, count) => { t.messages += count; }),
      ]);
      return t;
    },
  };
}

function bookingRow(i: Item): BookingRow {
  const [, startIso = '', ...rest] = String(i.SK).split('#');
  const name = str((i.customer as { name?: unknown } | undefined)?.name)?.split(/\s+/)[0];
  return {
    bookingId: str(i.bookingId) ?? rest.join('#'),
    start: str(i.start) ?? startIso,
    end: str(i.end) ?? '',
    serviceId: str(i.serviceId) ?? '',
    status: i.status === 'cancelled' ? 'cancelled' : 'confirmed',
    ...(name ? { customerFirstName: name } : {}),
  };
}

/** Summaries come from a model reading caller-controlled text: treat as data, so cap the size and drop control characters. */
function conversationRow(i: Item): ConversationRow {
  const [startedAt = '', ...rest] = String(i.SK).slice(CONV.length).split('#');
  const channel = str(i.channel);
  const summary = cleanText(i.summary, 500);
  const sentiment = sentimentOf(i.sentiment);
  const durationSec = seconds(i.durationSec);
  return {
    conversationId: rest.join('#'),
    startedAt,
    ...(channel ? { channel } : {}),
    ...(summary ? { summary } : {}),
    ...(sentiment ? { sentiment } : {}),
    ...(durationSec === undefined ? {} : { durationSec }),
    hasTranscript: !!str(i.transcriptKey),
  };
}

// ---- the summary ---------------------------------------------------------------------------------------------

export interface SummaryReport {
  calls: number; conversations: number; bookings: number; cancelledBookings: number; messages: number; minutes: number;
  sentiment: Record<Sentiment, number>;
}

export function summaryOf(t: Tally): SummaryReport {
  return {
    calls: t.calls, conversations: t.conversations, bookings: t.bookings, cancelledBookings: t.cancelledBookings, messages: t.messages,
    minutes: Math.round((t.seconds / 60) * 10) / 10,
    sentiment: t.sentiment,
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinNatural = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** One short line the copilot can say as is: "3 calls and 2 bookings, about 12 minutes on the phone. Most people sounded happy." */
export function summaryLine(s: SummaryReport): string {
  const chats = Math.max(s.conversations - s.calls, 0);
  const parts = [
    s.calls > 0 ? count(s.calls, 'call') : '',
    chats > 0 ? count(chats, 'chat') : '',
    s.bookings > 0 ? count(s.bookings, 'booking') : '',
    s.messages > 0 ? count(s.messages, 'message') : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'Nothing came in for those dates.';

  const mins = s.minutes > 0 ? Math.max(Math.round(s.minutes), 1) : 0;
  const talk = mins > 0 ? `, about ${count(mins, 'minute')} ${s.calls > 0 ? 'on the phone' : 'talking'}` : '';
  return [`${joinNatural(parts)}${talk}.`, moodLine(s.sentiment)].filter(Boolean).join(' ');
}

function moodLine(m: Record<Sentiment, number>): string {
  const scored = m.positive + m.neutral + m.negative;
  if (scored === 0) return '';
  const word: Record<Sentiment, string> = { positive: 'happy', neutral: 'fine', negative: 'unhappy' };
  const top = SENTIMENTS.reduce((a, b) => (m[b] > m[a] ? b : a), 'positive' as Sentiment);
  if (scored === 1) return `One person sounded ${word[top]}.`;
  const others = m.negative > 0 && top !== 'negative' ? (m.negative === 1 ? 'one person' : `${m.negative} people`) : '';
  if (m[top] * 2 > scored) {
    return `Most people sounded ${word[top]}${others ? `, but ${m.negative === 1 ? 'one' : m.negative} sounded unhappy` : ''}.`;
  }
  return `The mood was mixed${others ? `, and ${others} sounded unhappy` : ''}.`;
}
