import { describe, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mintTenantToken } from '@1145/shared';
import { getSummaryReport } from '../src/handlers/admin-summary.js';
import { listBookings } from '../src/handlers/admin-list-bookings.js';
import { listConversations } from '../src/handlers/admin-list-conversations.js';
import {
  createDdbReports, dayRange, REPORT_LINES, summaryLine, zonedInstant, type TenantReads,
} from '../src/lib/reports.js';
import type { HttpEvent } from '../src/lib/http.js';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { makeDeps, MemoryRepo, SECRET } from './fakes.js';

const TABLE = 't1145';
const A = 't_tenanta01';
const B = 't_tenantb01';
const NOW = new Date('2026-10-06T15:00:00Z');

type Item = Record<string, unknown> & { PK: string; SK: string };

/**
 * A DynamoDB Query/Get emulator that is strict about what the real service is strict about: the key condition must be
 * one partition plus one sort-key condition, ExclusiveStartKey must sit inside the queried range, Limit applies before
 * pages are cut, and a page can be cut short (like the 1 MB cap) so callers have to follow LastEvaluatedKey.
 */
class FakeDoc {
  items: Item[] = [];
  queries: Array<Record<string, any>> = [];
  gets: Array<Record<string, any>> = [];
  /** Max items one Query page returns, to mimic the 1 MB page cap. */
  pageCap = Number.POSITIVE_INFINITY;

  put(...items: Item[]) { this.items.push(...items); return this; }

  async send(cmd: unknown): Promise<any> {
    if (cmd instanceof GetCommand) {
      this.gets.push(cmd.input);
      const { PK, SK } = cmd.input.Key as { PK: string; SK: string };
      return { Item: this.items.find((i) => i.PK === PK && i.SK === SK) };
    }
    if (cmd instanceof QueryCommand) return this.query(cmd.input as Record<string, any>);
    throw new Error(`FakeDoc: unsupported command ${(cmd as { constructor: { name: string } }).constructor.name}`);
  }

  private query(q: Record<string, any>) {
    this.queries.push(q);
    if (q.IndexName) throw new Error('FakeDoc: reads in this lane use the base table only');
    const v = q.ExpressionAttributeValues as Record<string, string>;
    const kc = String(q.KeyConditionExpression);
    let inRange: (sk: string) => boolean;
    let m: RegExpMatchArray | null;
    if ((m = kc.match(/^PK = (:\w+) AND SK BETWEEN (:\w+) AND (:\w+)$/))) {
      const [lo, hi] = [v[m[2]!]!, v[m[3]!]!];
      inRange = (sk) => sk >= lo && sk <= hi;
    } else if ((m = kc.match(/^PK = (:\w+) AND begins_with\(SK, (:\w+)\)$/))) {
      const prefix = v[m[2]!]!;
      inRange = (sk) => sk.startsWith(prefix);
    } else {
      throw new Error(`FakeDoc: unsupported key condition ${kc}`);
    }
    const pk = v[(kc.match(/^PK = (:\w+)/) as RegExpMatchArray)[1]!]!;
    let rows = this.items.filter((i) => i.PK === pk && inRange(i.SK)).sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
    if (q.ScanIndexForward === false) rows = rows.reverse();
    const start = q.ExclusiveStartKey as { PK: string; SK: string } | undefined;
    if (start) {
      if (start.PK !== pk || !inRange(start.SK)) throw Object.assign(new Error('The provided starting key is outside query boundaries'), { name: 'ValidationException' });
      const at = rows.findIndex((r) => r.SK === start.SK);
      rows = rows.slice(at + 1);
    }
    const cap = Math.min(q.Limit ?? Number.POSITIVE_INFINITY, this.pageCap);
    const page = rows.slice(0, cap);
    const more = rows.length > page.length;
    const last = page[page.length - 1];
    const out: Record<string, unknown> = { Count: page.length, ...(more && last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } } : {}) };
    if (q.Select !== 'COUNT') out.Items = page.map((r) => ({ ...r }));
    return out;
  }
}

const doc = (f: FakeDoc) => f as unknown as DynamoDBDocumentClient;
const pk = (t: string) => `TENANT#${t}`;
const iso = (s: string) => new Date(s).toISOString();

const booking = (t: string, start: string, id: string, extra: Record<string, unknown> = {}): Item => ({
  PK: pk(t), SK: `BOOKING#${iso(start)}#${id}`, GSI1PK: `TENANT#${t}#BID`, GSI1SK: id,
  bookingId: id, start: iso(start), end: new Date(Date.parse(start) + 30 * 60_000).toISOString(), serviceId: 'cut', status: 'confirmed',
  customer: { name: 'Ada Obi', phone: '+12145550123', email: 'ada@example.com' }, via: 'voice', createdAt: '2026-10-01T10:00:00.000Z', ...extra,
});
const conv = (t: string, start: string, id: string, extra: Record<string, unknown> = {}): Item => ({
  PK: pk(t), SK: `CONV#${iso(start)}#${id}`, channel: 'voice', summary: 'Wanted a trim on Friday.', sentiment: 'neutral',
  transcriptKey: `tenants/${t}/transcripts/${id}.json`, ...extra,
});
const msg = (t: string, at: string, id: string): Item => ({
  PK: pk(t), SK: `MSG#${iso(at)}#${id}`, fromName: 'Sam', body: 'Call me back', urgency: 'normal', at: iso(at),
});
const profile = (t: string, timezone: string): Item => ({ PK: pk(t), SK: 'PROFILE', timezone, name: 'Kemi Cuts' });

/** Oct 5 2026 in America/Chicago (CDT, UTC-5) is 05:00Z to 05:00Z the next day. */
function fixture(f: FakeDoc, t: string, tz = 'America/Chicago') {
  f.put(
    profile(t, tz),
    booking(t, '2026-10-05T04:59:00Z', 'bk_a'), // Oct 4, 11:59 PM Chicago
    booking(t, '2026-10-05T05:00:00Z', 'bk_b'), // Oct 5, midnight Chicago
    booking(t, '2026-10-06T04:59:00Z', 'bk_c', { status: 'cancelled' }), // Oct 5, 11:59 PM Chicago
    booking(t, '2026-10-06T05:00:00Z', 'bk_d'), // Oct 6, midnight Chicago
    conv(t, '2026-10-04T12:00:00Z', 'c0', { sentiment: 'positive', durationSec: 600 }), // outside
    conv(t, '2026-10-05T15:00:00Z', 'c1', { sentiment: 'positive', durationSec: 120, billableSeconds: 120 }),
    conv(t, '2026-10-05T16:00:00Z', 'c2', { sentiment: 'neutral', durationSec: 61, billableSeconds: 66 }),
    conv(t, '2026-10-05T17:00:00Z', 'c3', { sentiment: 'negative', durationSec: 54 }),
    conv(t, '2026-10-05T18:00:00Z', 'c4', { channel: 'webchat', sentiment: 'positive' }),
    msg(t, '2026-10-05T14:00:00Z', 'm1'),
    msg(t, '2026-10-05T20:00:00Z', 'm2'),
    msg(t, '2026-10-06T05:30:00Z', 'm3'), // outside (Oct 6 Chicago)
  );
  return f;
}

type Who = 'owner' | 'staff' | 'admin-agent' | 'customer-agent';
function get(query: Record<string, string | undefined>, who: Who | 'cognito' = 'owner', tid = A): HttpEvent {
  if (who === 'cognito') {
    return {
      headers: {}, queryStringParameters: query,
      requestContext: { requestId: 'req-1', authorizer: { jwt: { claims: { 'custom:tenant_id': tid, 'custom:role': 'owner' } } } },
    };
  }
  const token = mintTenantToken({ tid, prn: who, cid: 'sess-1', ch: who === 'owner' || who === 'staff' ? 'dashboard' : 'voice' }, SECRET);
  return { headers: { authorization: `Bearer ${token}` }, queryStringParameters: query, requestContext: { requestId: 'req-1' } };
}

class ReportsRepo extends MemoryRepo {
  constructor(public reports?: TenantReads) { super(); }
}

function setup(f: FakeDoc, tenants: string[] = [A]) {
  const repos: Record<string, ReportsRepo> = {};
  for (const t of tenants) repos[t] = new ReportsRepo(createDdbReports(doc(f), t, TABLE));
  const made = makeDeps(repos, NOW);
  return { ...made, repos };
}

const body = (r: { body: string }) => JSON.parse(r.body);

describe('date ranges are interpreted in the tenant timezone', () => {
  it('maps a calendar day to local midnight, including the 23 and 25 hour DST days', () => {
    expect(dayRange('2026-10-05', '2026-10-05', 'America/Chicago')).toEqual({ start: new Date('2026-10-05T05:00:00.000Z'), end: new Date('2026-10-06T05:00:00.000Z') });
    expect(dayRange('2026-11-01', '2026-11-01', 'America/Chicago')).toEqual({ start: new Date('2026-11-01T05:00:00.000Z'), end: new Date('2026-11-02T06:00:00.000Z') });
    expect(dayRange('2026-03-08', '2026-03-08', 'America/Chicago')).toEqual({ start: new Date('2026-03-08T06:00:00.000Z'), end: new Date('2026-03-09T05:00:00.000Z') });
    expect(dayRange('2026-10-05', '2026-10-07', 'Pacific/Auckland')).toEqual({ start: new Date('2026-10-04T11:00:00.000Z'), end: new Date('2026-10-07T11:00:00.000Z') });
    expect(zonedInstant(2026, 10, 5, 9, 30, 0, 0, 'America/Chicago').toISOString()).toBe('2026-10-05T14:30:00.000Z');
  });

  it('counts the summary day boundaries in Chicago time, and shifts them for another timezone', async () => {
    const chi = fixture(new FakeDoc(), A);
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(chi).deps));
    expect(r).toMatchObject({ timezone: 'America/Chicago', from: '2026-10-05', to: '2026-10-05', bookings: 1, cancelledBookings: 1, messages: 2 });

    // Same stored instants, tenant in Auckland (UTC+13): bk_a and bk_b fall on Oct 5, bk_c does not.
    const akl = fixture(new FakeDoc(), A, 'Pacific/Auckland');
    const r2 = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(akl).deps));
    expect(r2).toMatchObject({ timezone: 'Pacific/Auckland', bookings: 2, cancelledBookings: 0 });
  });

  it('treats `to` as the whole last day', async () => {
    const f = fixture(new FakeDoc(), A);
    const r = body(await getSummaryReport(get({ from: '2026-10-04', to: '2026-10-05' }), setup(f).deps));
    expect(r.conversations).toBe(5); // c0 is on Oct 4 Chicago time
    expect(r.messages).toBe(2);
  });

  it('lists bookings for a date-only range, a local date-time range and an explicit-offset range', async () => {
    const f = fixture(new FakeDoc(), A);
    const { deps } = setup(f);
    const day = body(await listBookings(get({ from: '2026-10-05', to: '2026-10-05' }), deps));
    expect(day.map((b: { bookingId: string }) => b.bookingId)).toEqual(['bk_b', 'bk_c']);

    const local = body(await listBookings(get({ from: '2026-10-05T00:00:00', to: '2026-10-06T00:00:00' }), deps));
    expect(local.map((b: { bookingId: string }) => b.bookingId)).toEqual(['bk_b', 'bk_c']);

    const offset = body(await listBookings(get({ from: '2026-10-05T00:00:00-05:00', to: '2026-10-06T00:00:00-05:00' }), deps));
    expect(offset.map((b: { bookingId: string }) => b.bookingId)).toEqual(['bk_b', 'bk_c']);

    const utc = body(await listBookings(get({ from: '2026-10-05T04:59:00Z', to: '2026-10-05T05:00:00Z' }), deps));
    expect(utc.map((b: { bookingId: string }) => b.bookingId)).toEqual(['bk_a']); // `to` is exclusive
  });

  it('falls back to UTC when the tenant has no usable timezone, and says so in the response', async () => {
    const f = new FakeDoc().put(profile(A, 'Mars/Olympus'), booking(A, '2026-10-05T00:30:00Z', 'bk_u'));
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps));
    expect(r).toMatchObject({ timezone: 'UTC', bookings: 1 });
  });

  it('reads the timezone from business hours when the profile has none', async () => {
    const f = new FakeDoc().put({ PK: pk(A), SK: 'PROFILE', name: 'x' }, { PK: pk(A), SK: 'HOURS', timezone: 'America/Chicago', weekly: [] });
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps));
    expect(r.timezone).toBe('America/Chicago');
  });
});

describe('customer-agent is refused', () => {
  const handlers = [
    ['getSummaryReport', getSummaryReport, { from: '2026-10-05', to: '2026-10-05' }],
    ['listBookings', listBookings, { from: '2026-10-05', to: '2026-10-06' }],
    ['listConversations', listConversations, {}],
  ] as const;
  for (const [name, fn, query] of handlers) {
    it(`${name} -> 403 before touching any data`, async () => {
      const f = fixture(new FakeDoc(), A);
      const { deps, repoCalls } = setup(f);
      await expect(fn(get(query, 'customer-agent'), deps)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(repoCalls).toEqual([]);
      expect(f.queries).toHaveLength(0);
      expect(f.gets).toHaveLength(0);
    });
    it(`${name} -> 401 with no credentials`, async () => {
      const { deps } = setup(fixture(new FakeDoc(), A));
      await expect(fn({ headers: {}, queryStringParameters: query, requestContext: { requestId: 'r' } }, deps)).rejects.toMatchObject({ status: 401 });
    });
    for (const who of ['owner', 'staff', 'admin-agent', 'cognito'] as const) {
      it(`${name} is open to ${who}`, async () => {
        const { deps } = setup(fixture(new FakeDoc(), A));
        expect((await fn(get(query, who), deps)).statusCode).toBe(200);
      });
    }
  }
});

describe('getSummaryReport', () => {
  it('counts calls, bookings, messages, minutes and the sentiment mix', async () => {
    const f = fixture(new FakeDoc(), A);
    const res = await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      from: '2026-10-05', to: '2026-10-05', timezone: 'America/Chicago',
      calls: 3, conversations: 4, bookings: 1, cancelledBookings: 1, messages: 2,
      minutes: 4, // 120 + 66 billable + 54 on a call without a billable figure = 240 s
      sentiment: { positive: 2, neutral: 1, negative: 1 },
    });
  });

  it('returns zeros, not an error, for a quiet stretch', async () => {
    const f = new FakeDoc().put(profile(A, 'America/Chicago'));
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-11' }), setup(f).deps));
    expect(r).toMatchObject({ calls: 0, conversations: 0, bookings: 0, cancelledBookings: 0, messages: 0, minutes: 0, sentiment: { positive: 0, neutral: 0, negative: 0 } });
    expect(r.sayToCaller).toMatch(/nothing|quiet|no /i);
  });

  it('ignores conversations with an unknown sentiment instead of miscounting them', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'), conv(A, '2026-10-05T10:00:00Z', 'x1', { sentiment: 'ecstatic' }), conv(A, '2026-10-05T11:00:00Z', 'x2', { sentiment: undefined }));
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps));
    expect(r).toMatchObject({ conversations: 2, sentiment: { positive: 0, neutral: 0, negative: 0 } });
  });

  it('is built from the tenant partition only, never from another tenant or the request', async () => {
    const f = fixture(fixture(new FakeDoc(), A), B);
    f.put(msg(B, '2026-10-05T14:30:00Z', 'mb1'), conv(B, '2026-10-05T14:30:00Z', 'cb1'));
    const { deps, repoCalls } = setup(f, [A, B]);
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05', tenantId: B, tid: B }), deps));
    expect(repoCalls).toEqual([A]);
    expect(r.messages).toBe(2);
    expect(r.conversations).toBe(4);
    const pks = new Set([...f.queries.map((q) => q.ExpressionAttributeValues[':pk']), ...f.gets.map((g) => g.Key.PK)]);
    expect([...pks]).toEqual([pk(A)]);
  });

  it('pages through every result and keeps working when a page comes back short', async () => {
    const f = fixture(new FakeDoc(), A);
    f.pageCap = 1;
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps));
    expect(r).toMatchObject({ calls: 3, conversations: 4, bookings: 1, cancelledBookings: 1, messages: 2, minutes: 4 });
    expect(f.queries.length).toBeGreaterThan(3);
  });

  it('only asks DynamoDB for what it counts', async () => {
    const f = fixture(new FakeDoc(), A);
    await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps);
    const messageQuery = f.queries.find((q) => String(q.ExpressionAttributeValues[':a']).startsWith('MSG#'));
    expect(messageQuery?.Select).toBe('COUNT');
    for (const q of f.queries) expect(q.KeyConditionExpression).toMatch(/^PK = :pk AND /);
  });

  it('rejects missing, malformed, reversed and oversized ranges with a line the owner can act on', async () => {
    const { deps } = setup(fixture(new FakeDoc(), A));
    const bad: Array<[Record<string, string | undefined>, string]> = [
      [{}, 'invalid'],
      [{ from: '2026-10-05' }, 'invalid'],
      [{ from: 'last week', to: '2026-10-05' }, 'invalid'],
      [{ from: '2026-02-30', to: '2026-03-01' }, 'invalid'],
      [{ from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' }, 'invalid'],
      [{ from: '2026-10-06', to: '2026-10-05' }, 'bad_range'],
      [{ from: '2024-01-01', to: '2026-10-05' }, 'range_too_wide'],
    ];
    for (const [q, code] of bad) {
      const err = await getSummaryReport(get(q), deps).catch((e) => e);
      expect(err, JSON.stringify(q)).toMatchObject({ status: 400, code });
      expect(checkReply(err.sayToCaller, { channel: 'chat' }), err.sayToCaller).toEqual([]);
    }
  });

  it('says a short, natural line the copilot can read out', async () => {
    const f = fixture(new FakeDoc(), A);
    const r = body(await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps));
    expect(r.sayToCaller).toBe('3 calls, 1 chat, 1 booking and 2 messages, about 4 minutes on the phone. The mood was mixed, and one person sounded unhappy.');
  });

  it('answers 501 with a natural line when the repo has no read layer yet', async () => {
    const bare = new MemoryRepo();
    const { deps } = makeDeps({ [A]: bare }, NOW);
    const err = await getSummaryReport(get({ from: '2026-10-05', to: '2026-10-05' }), deps).catch((e) => e);
    expect(err).toMatchObject({ status: 501, code: 'not_implemented' });
    expect(checkReply(err.sayToCaller, { channel: 'chat' })).toEqual([]);
  });
});

describe('listBookings', () => {
  const ids = (rows: Array<{ bookingId: string }>) => rows.map((b) => b.bookingId);

  it('returns the contract shape, oldest first, with no customer contact details', async () => {
    const f = fixture(new FakeDoc(), A);
    const res = await listBookings(get({ from: '2026-10-05', to: '2026-10-05' }), setup(f).deps);
    expect(res.statusCode).toBe(200);
    const rows = body(res);
    expect(rows).toEqual([
      { bookingId: 'bk_b', start: '2026-10-05T05:00:00.000Z', end: '2026-10-05T05:30:00.000Z', serviceId: 'cut', status: 'confirmed', customerFirstName: 'Ada' },
      { bookingId: 'bk_c', start: '2026-10-06T04:59:00.000Z', end: '2026-10-06T05:29:00.000Z', serviceId: 'cut', status: 'cancelled', customerFirstName: 'Ada' },
    ]);
    expect(res.body).not.toMatch(/2145550123|ada@example|GSI1|TENANT#|customer"/);
  });

  it('pages with an opaque cursor in X-Next-Cursor, with no repeats and no dangling last cursor', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'));
    for (let i = 1; i <= 5; i++) f.put(booking(A, `2026-10-05T0${i}:00:00Z`, `bk_${i}`));
    const { deps } = setup(f);
    const q = { from: '2026-10-05', to: '2026-10-05', limit: '2' };

    const p1 = await listBookings(get(q), deps);
    expect(ids(body(p1))).toEqual(['bk_1', 'bk_2']);
    const c1 = p1.headers?.['x-next-cursor'];
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);

    const p2 = await listBookings(get({ ...q, cursor: c1 }), deps);
    expect(ids(body(p2))).toEqual(['bk_3', 'bk_4']);
    const c2 = p2.headers?.['x-next-cursor'];
    expect(c2).toBeTruthy();

    const p3 = await listBookings(get({ ...q, cursor: c2 }), deps);
    expect(ids(body(p3))).toEqual(['bk_5']);
    expect(p3.headers?.['x-next-cursor']).toBeUndefined();

    // Exactly two full pages: the second page must not advertise a third.
    const four = new FakeDoc().put(profile(A, 'UTC'), ...[1, 2, 3, 4].map((i) => booking(A, `2026-10-05T0${i}:00:00Z`, `bk_${i}`)));
    const d4 = setup(four).deps;
    const first = await listBookings(get(q), d4);
    const second = await listBookings(get({ ...q, cursor: first.headers?.['x-next-cursor'] }), d4);
    expect(ids(body(second))).toEqual(['bk_3', 'bk_4']);
    expect(second.headers?.['x-next-cursor']).toBeUndefined();
  });

  it('still fills a page when DynamoDB returns short pages', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'));
    for (let i = 1; i <= 5; i++) f.put(booking(A, `2026-10-05T0${i}:00:00Z`, `bk_${i}`));
    f.pageCap = 1;
    const res = await listBookings(get({ from: '2026-10-05', to: '2026-10-05', limit: '3' }), setup(f).deps);
    expect(ids(body(res))).toEqual(['bk_1', 'bk_2', 'bk_3']);
    expect(res.headers?.['x-next-cursor']).toBeTruthy();
  });

  it('defaults to 100 rows and caps limit at 200', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'));
    for (let i = 0; i < 250; i++) f.put(booking(A, new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString(), `bk_${String(i).padStart(3, '0')}`));
    const { deps } = setup(f);
    expect(body(await listBookings(get({ from: '2026-10-05', to: '2026-10-05' }), deps))).toHaveLength(100);
    expect(body(await listBookings(get({ from: '2026-10-05', to: '2026-10-05', limit: '999' }), deps))).toHaveLength(200);
  });

  it('refuses a cursor that points outside this tenant, this range or this kind of item', async () => {
    const f = fixture(new FakeDoc(), A);
    const { deps } = setup(f);
    const forge = (raw: string) => Buffer.from(raw).toString('base64url');
    const q = { from: '2026-10-05', to: '2026-10-05', limit: '1' };
    for (const raw of [
      JSON.stringify({ PK: pk(B), SK: 'BOOKING#2026-10-05T05:00:00.000Z#bk_b' }),
      `TENANT#${B}`,
      'BOOKING#2099-01-01T00:00:00.000Z#bk_x', // outside the requested range
      'CONV#2026-10-05T15:00:00.000Z#c1', // wrong kind of item
      'PROFILE',
    ]) {
      await expect(listBookings(get({ ...q, cursor: forge(raw) }), deps), raw).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
    await expect(listBookings(get({ ...q, cursor: '%%%not-base64%%%' }), deps)).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    expect(f.queries.every((x) => x.ExpressionAttributeValues[':pk'] === pk(A))).toBe(true);
  });

  it('only reads its own partition and ignores a tenant id in the query string', async () => {
    const f = fixture(fixture(new FakeDoc(), A), B);
    f.put(booking(B, '2026-10-05T12:00:00Z', 'bk_other'));
    const { deps, repoCalls } = setup(f, [A, B]);
    const rows = body(await listBookings(get({ from: '2026-10-05', to: '2026-10-05', tenantId: B }), deps));
    expect(ids(rows)).toEqual(['bk_b', 'bk_c']);
    expect(repoCalls).toEqual([A]);
    expect(f.queries.every((x) => x.ExpressionAttributeValues[':pk'] === pk(A))).toBe(true);
  });

  it('rejects missing and reversed bounds and a bad limit with natural lines', async () => {
    const { deps } = setup(fixture(new FakeDoc(), A));
    const bad: Array<[Record<string, string | undefined>, string]> = [
      [{}, 'invalid'],
      [{ from: '2026-10-05' }, 'invalid'],
      [{ from: 'soon', to: 'later' }, 'invalid'],
      [{ from: '2026-10-06', to: '2026-10-05' }, 'bad_range'],
      [{ from: '2026-10-05', to: '2026-10-05', limit: 'ten' }, 'invalid'],
      [{ from: '2026-10-05', to: '2026-10-05', limit: '0' }, 'invalid'],
      [{ from: '2024-01-01', to: '2026-10-05' }, 'range_too_wide'],
    ];
    for (const [q, code] of bad) {
      const err = await listBookings(get(q), deps).catch((e) => e);
      expect(err, JSON.stringify(q)).toMatchObject({ status: 400, code });
      expect(checkReply(err.sayToCaller, { channel: 'chat' }), err.sayToCaller).toEqual([]);
    }
  });
});

describe('listConversations', () => {
  const many = (f: FakeDoc, t: string, n: number) => {
    for (let i = 0; i < n; i++) f.put(conv(t, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), `c_${String(i).padStart(3, '0')}`, { summary: `Call number ${i}` }));
    return f;
  };

  it('returns the newest conversations first with summary and sentiment, and never the transcript location', async () => {
    const f = fixture(new FakeDoc(), A);
    const res = await listConversations(get({}), setup(f).deps);
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.conversations.map((c: { conversationId: string }) => c.conversationId)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0']);
    expect(b.conversations[1]).toEqual({
      conversationId: 'c3', startedAt: '2026-10-05T17:00:00.000Z', channel: 'voice', summary: 'Wanted a trim on Friday.',
      sentiment: 'negative', durationSec: 54, hasTranscript: true,
    });
    expect(b.nextCursor).toBeUndefined();
    expect(res.body).not.toMatch(/transcriptKey|tenants\/|TENANT#|"PK"|"SK"/);
  });

  it('defaults to 20, never returns more than 50, and pages newest to oldest without repeats', async () => {
    const f = many(new FakeDoc(), A, 120);
    const { deps } = setup(f);
    const p1 = await listConversations(get({}), deps);
    expect(body(p1).conversations).toHaveLength(20);
    expect(body(p1).conversations[0].conversationId).toBe('c_119');

    const big = await listConversations(get({ limit: '500' }), deps);
    expect(body(big).conversations).toHaveLength(50);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const r = await listConversations(get({ limit: '50', cursor }), deps);
      seen.push(...body(r).conversations.map((c: { conversationId: string }) => c.conversationId));
      cursor = body(r).nextCursor;
      expect(r.headers?.['x-next-cursor']).toBe(cursor);
      if (!cursor) break;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('c_119');
    expect(seen[119]).toBe('c_000');
  });

  it('queries one partition, newest first, with a bounded Limit', async () => {
    const f = many(new FakeDoc(), B, 5);
    many(f, A, 5);
    const { deps } = setup(f, [A, B]);
    await listConversations(get({ tenantId: B, limit: '3' }), deps);
    expect(f.queries).toHaveLength(1);
    const q = f.queries[0]!;
    expect(q.ExpressionAttributeValues[':pk']).toBe(pk(A));
    expect(q.ScanIndexForward).toBe(false);
    expect(q.Limit).toBeLessThanOrEqual(51);
  });

  it('refuses a forged cursor', async () => {
    const f = many(new FakeDoc(), A, 5);
    const { deps } = setup(f);
    for (const raw of [`TENANT#${B}`, 'BOOKING#2026-10-05T05:00:00.000Z#bk_b', 'CONV#', '']) {
      await expect(listConversations(get({ cursor: Buffer.from(raw).toString('base64url') }), deps), raw).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
  });

  it('treats summaries as data: caps their length and strips control characters', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'), conv(A, '2026-10-05T10:00:00Z', 'x', { summary: `${'a'.repeat(900)}\u0000\u001b[31m` }));
    const b = body(await listConversations(get({}), setup(f).deps));
    expect(b.conversations[0].summary.length).toBeLessThanOrEqual(500);
    expect(b.conversations[0].summary).not.toMatch(/[\u0000-\u001f]/);
  });

  it('leaves out sentiment values it does not recognise and tolerates sparse items', async () => {
    const f = new FakeDoc().put(profile(A, 'UTC'), conv(A, '2026-10-05T10:00:00Z', 'x', { sentiment: 'furious', summary: undefined, channel: undefined, transcriptKey: undefined }));
    const c = body(await listConversations(get({}), setup(f).deps)).conversations[0];
    expect(c).toEqual({ conversationId: 'x', startedAt: '2026-10-05T10:00:00.000Z', hasTranscript: false });
  });

  it('rejects a bad limit', async () => {
    const { deps } = setup(fixture(new FakeDoc(), A));
    for (const limit of ['abc', '0', '-3', '2.5']) {
      const err = await listConversations(get({ limit }), deps).catch((e) => e);
      expect(err, limit).toMatchObject({ status: 400, code: 'invalid' });
      expect(checkReply(err.sayToCaller, { channel: 'chat' })).toEqual([]);
    }
  });
});

describe('everything an owner reads passes the conversation style checks', () => {
  it('error lines pass on both channels', () => {
    for (const [name, line] of Object.entries(REPORT_LINES)) {
      for (const channel of ['chat', 'voice'] as const) {
        expect(checkReply(line, { channel }), `${name}: ${line}`).toEqual([]);
      }
    }
  });

  it('the summary line reads naturally for every shape of week', () => {
    const base = { calls: 0, conversations: 0, bookings: 0, cancelledBookings: 0, messages: 0, minutes: 0, sentiment: { positive: 0, neutral: 0, negative: 0 } };
    const shapes = [
      { ...base },
      { ...base, messages: 1 },
      { ...base, bookings: 1 },
      { ...base, calls: 1, conversations: 1, minutes: 0.5, sentiment: { positive: 1, neutral: 0, negative: 0 } },
      { ...base, calls: 14, conversations: 14, bookings: 9, messages: 3, minutes: 42.3, sentiment: { positive: 9, neutral: 3, negative: 2 } },
      { ...base, calls: 6, conversations: 6, bookings: 0, cancelledBookings: 2, messages: 0, minutes: 11, sentiment: { positive: 1, neutral: 1, negative: 4 } },
      { ...base, calls: 5, conversations: 5, minutes: 9, sentiment: { positive: 0, neutral: 5, negative: 0 } },
      { ...base, calls: 120, conversations: 130, bookings: 80, messages: 40, minutes: 1500, sentiment: { positive: 60, neutral: 40, negative: 20 } },
      { ...base, conversations: 3, sentiment: { positive: 0, neutral: 0, negative: 1 } },
    ];
    for (const s of shapes) {
      const line = summaryLine(s);
      expect(line.length, JSON.stringify(s)).toBeGreaterThan(0);
      for (const channel of ['chat', 'voice'] as const) expect(checkReply(line, { channel }), line).toEqual([]);
    }
    expect(summaryLine({ ...base, bookings: 1 })).toBe('1 booking.');
    expect(summaryLine({ ...base, calls: 5, conversations: 5, minutes: 9, sentiment: { positive: 0, neutral: 5, negative: 0 } })).toBe('5 calls, about 9 minutes on the phone. Most people sounded fine.');
    expect(summaryLine({ ...base, calls: 14, conversations: 14, bookings: 9, messages: 3, minutes: 42.3, sentiment: { positive: 9, neutral: 3, negative: 2 } }))
      .toBe('14 calls, 9 bookings and 3 messages, about 42 minutes on the phone. Most people sounded happy, but 2 sounded unhappy.');
    expect(summaryLine({ ...base })).toBe('Nothing came in for those dates.');
    expect(summaryLine({ ...base, calls: 1, conversations: 1, minutes: 0.5 })).toBe('1 call, about 1 minute on the phone.');
  });
});

describe('speed: p95 under 300 ms over a 5,000 item tenant partition', () => {
  const N = 5_000;
  function load(put: (items: Item[]) => void, t: string) {
    const items: Item[] = [profile(t, 'America/Chicago')];
    const sentiments = ['positive', 'neutral', 'negative'];
    for (let i = 0; i < N; i++) {
      const at = new Date(Date.UTC(2026, 9, 1) + i * 8 * 60_000).toISOString(); // 8 minute spacing, ~28 days
      if (i % 10 < 5) items.push({ PK: pk(t), SK: `CONV#${at}#c${i}`, channel: i % 5 === 0 ? 'webchat' : 'voice', summary: `Caller ${i} asked about a trim`, sentiment: sentiments[i % 3], durationSec: 30 + (i % 240), transcriptKey: `tenants/${t}/transcripts/c${i}.json` });
      else if (i % 10 < 8) items.push({ PK: pk(t), SK: `BOOKING#${at}#bk${i}`, bookingId: `bk${i}`, start: at, end: at, serviceId: 'cut', status: i % 7 ? 'confirmed' : 'cancelled', customer: { name: 'Ada Obi' } });
      else items.push({ PK: pk(t), SK: `MSG#${at}#m${i}`, fromName: 'Sam', body: 'Call me', urgency: 'normal', at });
    }
    put(items);
    return items.length;
  }
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

  async function measure(deps: ReturnType<typeof setup>['deps'], runs = 60) {
    const month = { from: '2026-10-01', to: '2026-10-31' };
    const jobs: Array<[string, () => Promise<{ statusCode: number }>]> = [
      ['summary', () => getSummaryReport(get(month), deps)],
      ['bookings', () => listBookings(get({ ...month, limit: '200' }), deps)],
      ['conversations', () => listConversations(get({ limit: '50' }), deps)],
    ];
    const out: Record<string, number> = {};
    for (const [name, run] of jobs) {
      await run(); // warm the Intl formatter and module caches like a warm Lambda
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = await run();
        times.push(performance.now() - t0);
        expect(r.statusCode).toBe(200);
      }
      out[name] = p95(times);
    }
    return out;
  }

  it('over an in-memory table with 1 MB style page cuts', async () => {
    const f = new FakeDoc();
    f.pageCap = 1_000;
    expect(load((i) => f.put(...i), A)).toBeGreaterThan(N);
    const { deps } = setup(f);
    const r = body(await getSummaryReport(get({ from: '2026-10-01', to: '2026-10-31' }), deps));
    expect(r.conversations + r.bookings + r.cancelledBookings + r.messages).toBe(N);
    const times = await measure(deps);
    for (const [name, ms] of Object.entries(times)) expect(ms, `${name} p95 ${ms.toFixed(1)} ms`).toBeLessThan(300);
  });

  it('issues a bounded number of DynamoDB calls per request', async () => {
    const f = new FakeDoc();
    f.pageCap = 1_000;
    load((i) => f.put(...i), A);
    const { deps } = setup(f);
    f.queries.length = 0; f.gets.length = 0;
    await getSummaryReport(get({ from: '2026-10-01', to: '2026-10-31' }), deps);
    expect(f.gets.length).toBeLessThanOrEqual(2);
    expect(f.queries.length).toBeLessThanOrEqual(6); // 5,000 items at 1,000 per page, split across three prefixes
    f.queries.length = 0;
    await listConversations(get({ limit: '50' }), deps);
    expect(f.queries).toHaveLength(1);
  });

  // Real DynamoDB semantics. Skipped, not faked, unless DYNAMODB_LOCAL_ENDPOINT is set (see services/tool-api/bench/README.md).
  const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
  it.skipIf(!endpoint)('against DynamoDB Local with a 5,000 item fixture', async () => {
    const table = `t1145_reads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const real = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
    await raw.send(new CreateTableCommand({
      TableName: table, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' }, { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'GSI1', Projection: { ProjectionType: 'ALL' },
        KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }],
      }],
    }));
    try {
      const all: Item[] = [];
      load((i) => all.push(...i), A);
      for (let i = 0; i < all.length; i += 25) {
        let pending: Record<string, any[]> | undefined = { [table]: all.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
        while (pending && Object.keys(pending).length) {
          const r: { UnprocessedItems?: Record<string, any[]> } = await real.send(new BatchWriteCommand({ RequestItems: pending }));
          pending = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length ? r.UnprocessedItems : undefined;
        }
      }
      const repo = new ReportsRepo(createDdbReports(real, A, table));
      const { deps } = makeDeps({ [A]: repo }, NOW);
      const times = await measure(deps);
      for (const [name, ms] of Object.entries(times)) expect(ms, `${name} p95 ${ms.toFixed(1)} ms`).toBeLessThan(300);
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: table }));
      raw.destroy();
    }
  }, 120_000);
});
