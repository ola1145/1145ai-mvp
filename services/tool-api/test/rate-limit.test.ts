import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import { handle, header, HttpError, json, setRequestGuard, type HttpEvent, type HttpResult, type RequestGuard } from '../src/lib/http.js';
import {
  DEFAULT_POLICIES, RATE_LIMIT_LINES, VERIFICATION_FAILURE_CODES, VERIFICATION_FIELDS,
  createLimiter, createRequestGuard, ddbBucketStore, prodRequestGuard,
  type BucketPolicy, type BucketState, type BucketStore, type DocLike, type Limiter,
} from '../src/lib/rate-limit.js';
import { lookupCaller } from '../src/handlers/lookup-caller.js';
import { mintTenantToken } from '@1145/shared';
import { MemoryRepo, SECRET, makeDeps, voiceEvent } from './fakes.js';

// ---- fakes ---------------------------------------------------------------------------------------------------------

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

/** In-memory bucket store with the same compare-and-set contract as the DynamoDB adapter. Counts every round trip. */
class MemoryBucketStore implements BucketStore {
  items = new Map<string, BucketState & { ttl: number }>();
  reads = 0;
  writes = 0;
  failWith: Error | undefined;
  hang = false;
  async read(tenantId: string, bucket: string) {
    this.reads++;
    await tick();
    if (this.hang) await new Promise(() => {});
    if (this.failWith) throw this.failWith;
    const i = this.items.get(`${tenantId}|${bucket}`);
    return i ? { tokensMilli: i.tokensMilli, at: i.at, v: i.v } : undefined;
  }
  async write(tenantId: string, bucket: string, next: BucketState, prev: BucketState | undefined, ttl: number) {
    this.writes++;
    await tick();
    if (this.failWith) throw this.failWith;
    const key = `${tenantId}|${bucket}`;
    const cur = this.items.get(key);
    if (prev ? cur?.v !== prev.v : cur !== undefined) return false;
    this.items.set(key, { ...next, ttl });
    return true;
  }
  keys() { return [...this.items.keys()]; }
}

/** Just enough of DynamoDB for the two commands the adapter sends. Mirrors the two condition expressions it uses. */
class FakeDdb implements DocLike {
  items = new Map<string, Record<string, unknown>>();
  sent: Array<{ op: 'Get' | 'Put'; input: Record<string, unknown> }> = [];
  async send(cmd: unknown): Promise<{ Item?: Record<string, unknown> }> {
    if (cmd instanceof GetCommand) {
      this.sent.push({ op: 'Get', input: cmd.input as Record<string, unknown> });
      const k = cmd.input.Key as { PK: string; SK: string };
      return { Item: this.items.get(`${k.PK}|${k.SK}`) };
    }
    if (cmd instanceof PutCommand) {
      this.sent.push({ op: 'Put', input: cmd.input as Record<string, unknown> });
      const item = cmd.input.Item as { PK: string; SK: string };
      const key = `${item.PK}|${item.SK}`;
      const cur = this.items.get(key);
      const cond = cmd.input.ConditionExpression;
      const vals = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const ok = cond === 'attribute_not_exists(PK)' ? cur === undefined
        : cond === 'v = :prev' ? cur !== undefined && cur.v === vals[':prev']
        : (() => { throw new Error(`unsupported condition ${String(cond)}`); })();
      if (!ok) throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      this.items.set(key, item);
      return {};
    }
    throw new Error('unexpected command');
  }
}

/** ABAC stand-in: the client handed out for a tenant can only touch that tenant's partition (ADR-0003). */
const scopedDoc = (ddb: FakeDdb) => async (tid: string): Promise<DocLike> => ({
  send: async (cmd: unknown) => {
    const input = (cmd as { input: { Key?: { PK: string }; Item?: { PK: string } } }).input;
    const pk = input.Key?.PK ?? input.Item?.PK;
    if (pk !== `TENANT#${tid}`) throw new Error(`AccessDenied: ${String(pk)} is outside TENANT#${tid}`);
    return ddb.send(cmd);
  },
});

const T0 = Date.parse('2026-10-06T15:00:00Z');
const P3: BucketPolicy = { capacity: 3, refillPerSec: 1 };

function clockAndLimiter(store: BucketStore = new MemoryBucketStore()) {
  const clock = { t: T0 };
  const limiter = createLimiter({ store, now: () => clock.t });
  return { clock, limiter, store };
}

// ---- token bucket --------------------------------------------------------------------------------------------------

describe('token bucket', () => {
  it('lets a full bucket burst, then says no with a retry time', async () => {
    const { limiter } = clockAndLimiter();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.take('t_tenanta01', 'RATE#customer-agent', P3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2]!.remaining).toBe(0);
    expect(results[3]).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 1 });
  });

  it('refills over time and never above capacity', async () => {
    const { clock, limiter } = clockAndLimiter();
    for (let i = 0; i < 3; i++) await limiter.take('t_tenanta01', 'RATE#owner', P3);
    expect((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(false);
    clock.t += 1000;
    expect((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(true);
    expect((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(false);
    clock.t += 3_600_000;
    const burst = [];
    for (let i = 0; i < 5; i++) burst.push((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed);
    expect(burst).toEqual([true, true, true, false, false]);
  });

  it('rounds the retry time up to whole seconds for slow refill rates', async () => {
    const { limiter } = clockAndLimiter();
    const slow: BucketPolicy = { capacity: 1, refillPerSec: 0.4 };
    await limiter.take('t_tenanta01', 'RATE#owner', slow);
    expect((await limiter.take('t_tenanta01', 'RATE#owner', slow)).retryAfterSec).toBe(3); // 2.5 s
  });

  it('keeps separate buckets per tenant and per principal', async () => {
    const { limiter } = clockAndLimiter();
    for (let i = 0; i < 3; i++) await limiter.take('t_tenanta01', 'RATE#customer-agent', P3);
    expect((await limiter.take('t_tenanta01', 'RATE#customer-agent', P3)).allowed).toBe(false);
    expect((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(true);
    expect((await limiter.take('t_tenantb02', 'RATE#customer-agent', P3)).allowed).toBe(true);
  });

  it('does not write when it says no, so a flood costs reads of nothing', async () => {
    const { limiter, store } = clockAndLimiter();
    for (let i = 0; i < 3; i++) await limiter.take('t_tenanta01', 'RATE#owner', P3);
    const before = { reads: (store as MemoryBucketStore).reads, writes: (store as MemoryBucketStore).writes };
    for (let i = 0; i < 20; i++) expect((await limiter.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(false);
    expect({ reads: (store as MemoryBucketStore).reads, writes: (store as MemoryBucketStore).writes }).toEqual(before);
  });

  it('costs one write and no read per request once the bucket is warm', async () => {
    const store = new MemoryBucketStore();
    const { limiter } = clockAndLimiter(store);
    await limiter.take('t_tenanta01', 'RATE#owner', { capacity: 50, refillPerSec: 5 });
    expect(store).toMatchObject({ reads: 1, writes: 1 });
    for (let i = 0; i < 10; i++) await limiter.take('t_tenanta01', 'RATE#owner', { capacity: 50, refillPerSec: 5 });
    expect(store).toMatchObject({ reads: 1, writes: 11 });
  });

  it('sets a TTL that is after the bucket would have refilled completely', async () => {
    const store = new MemoryBucketStore();
    const { limiter } = clockAndLimiter(store);
    await limiter.take('t_tenanta01', 'RATE#owner', P3);
    const ttl = store.items.get('t_tenanta01|RATE#owner')!.ttl;
    expect(ttl).toBeGreaterThan(Math.floor(T0 / 1000) + 3); // capacity 3 at 1/s refills in 3 s
    expect(ttl).toBeLessThan(Math.floor(T0 / 1000) + 3600);
  });

  it('never overspends when two containers share a bucket with stale local state', async () => {
    const store = new MemoryBucketStore();
    const clock = { t: T0 };
    const a = createLimiter({ store, now: () => clock.t });
    const b = createLimiter({ store, now: () => clock.t });
    const slow: BucketPolicy = { capacity: 3, refillPerSec: 0.001 };
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      allowed.push((await a.take('t_tenanta01', 'RATE#owner', slow)).allowed);
      allowed.push((await b.take('t_tenanta01', 'RATE#owner', slow)).allowed);
    }
    expect(allowed.filter(Boolean)).toHaveLength(3);
  });

  it('never overspends under parallel containers either', async () => {
    const store = new MemoryBucketStore();
    const clock = { t: T0 };
    const a = createLimiter({ store, now: () => clock.t });
    const b = createLimiter({ store, now: () => clock.t });
    const slow: BucketPolicy = { capacity: 12, refillPerSec: 0.001 };
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).take('t_tenanta01', 'RATE#owner', slow)));
    const n = all.filter((r) => r.allowed).length;
    expect(n).toBeLessThanOrEqual(12);
    expect(n).toBeGreaterThan(0);
  });

  it('serialises parallel requests inside one container: exactly capacity get through', async () => {
    const { limiter } = clockAndLimiter();
    const slow: BucketPolicy = { capacity: 30, refillPerSec: 0.001 };
    const all = await Promise.all(Array.from({ length: 80 }, () => limiter.take('t_tenanta01', 'RATE#customer-agent', slow)));
    expect(all.filter((r) => r.allowed)).toHaveLength(30);
  });

  it('peek reads the store and never consumes', async () => {
    const store = new MemoryBucketStore();
    const { limiter } = clockAndLimiter(store);
    expect(await limiter.peek('t_tenanta01', 'RATE#x', P3)).toMatchObject({ allowed: true, remaining: 3 });
    await limiter.take('t_tenanta01', 'RATE#x', P3, 3);
    const writes = store.writes;
    expect(await limiter.peek('t_tenanta01', 'RATE#x', P3)).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 1 });
    expect(store.writes).toBe(writes);
  });
});

// ---- DynamoDB adapter ----------------------------------------------------------------------------------------------

describe('ddbBucketStore', () => {
  it('keeps the bucket in the tenant partition with a version, a timestamp and a TTL', async () => {
    const ddb = new FakeDdb();
    const { limiter } = clockAndLimiter(ddbBucketStore(scopedDoc(ddb), 't1145'));
    await limiter.take('t_tenanta01', 'RATE#customer-agent', P3);
    const put = ddb.sent.find((s) => s.op === 'Put')!.input;
    expect(put.TableName).toBe('t1145');
    expect(put.Item).toMatchObject({ PK: 'TENANT#t_tenanta01', SK: 'RATE#customer-agent', tokensMilli: 2000, at: T0, v: 1 });
    expect((put.Item as { ttl: number }).ttl).toBeGreaterThan(Math.floor(T0 / 1000));
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('reads strongly consistent, then updates with a version condition', async () => {
    const ddb = new FakeDdb();
    const { clock, limiter } = clockAndLimiter(ddbBucketStore(scopedDoc(ddb)));
    await limiter.take('t_tenanta01', 'RATE#owner', P3);
    // a second container (no local state) has to read what the first wrote
    const other = createLimiter({ store: ddbBucketStore(scopedDoc(ddb)), now: () => clock.t });
    await other.take('t_tenanta01', 'RATE#owner', P3);
    const get = ddb.sent.find((s) => s.op === 'Get')!.input;
    expect(get).toMatchObject({ ConsistentRead: true, Key: { PK: 'TENANT#t_tenanta01', SK: 'RATE#owner' } });
    const puts = ddb.sent.filter((s) => s.op === 'Put').map((s) => s.input);
    expect(puts[1]).toMatchObject({ ConditionExpression: 'v = :prev', ExpressionAttributeValues: { ':prev': 1 } });
    expect(ddb.items.get('TENANT#t_tenanta01|RATE#owner')).toMatchObject({ tokensMilli: 1000, v: 2 });
  });

  it('enforces the limit through the adapter and never leaves the tenant partition', async () => {
    const ddb = new FakeDdb();
    const { limiter } = clockAndLimiter(ddbBucketStore(scopedDoc(ddb)));
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await limiter.take('t_tenanta01', 'RATE#customer-agent', P3)).allowed);
    expect(outcomes).toEqual([true, true, true, false, false]);
    expect((await limiter.take('t_tenantb02', 'RATE#customer-agent', P3)).allowed).toBe(true);
    for (const k of ddb.items.keys()) expect(k).toMatch(/^TENANT#t_tenant(a01|b02)\|RATE#/);
  });

  it('turns a lost compare-and-set into a retry, not an error', async () => {
    const ddb = new FakeDdb();
    const { clock, limiter: a } = clockAndLimiter(ddbBucketStore(scopedDoc(ddb)));
    const b = createLimiter({ store: ddbBucketStore(scopedDoc(ddb)), now: () => clock.t });
    expect((await a.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(true);
    expect((await b.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(true);
    // a's local copy is now stale (v=1, store has v=2): its write fails the condition and it re-reads
    expect((await a.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(true);
    expect((await a.take('t_tenanta01', 'RATE#owner', P3)).allowed).toBe(false);
  });

  it('lets other DynamoDB errors through for the guard to handle', async () => {
    const failing: DocLike = { send: async () => { throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }); } };
    const { limiter } = clockAndLimiter(ddbBucketStore(async () => failing));
    await expect(limiter.take('t_tenanta01', 'RATE#owner', P3)).rejects.toThrow('throttled');
  });

  it('refuses a tenant id that could escape its key prefix', async () => {
    const { limiter } = clockAndLimiter(ddbBucketStore(scopedDoc(new FakeDdb())));
    await expect(limiter.take('t_x#TENANT#t_other', 'RATE#owner', P3)).rejects.toThrow();
  });
});

// ---- the guard -----------------------------------------------------------------------------------------------------

const QUIET = () => {};
const VPOL = { caller: { capacity: 3, refillPerSec: 1 / 600 }, tenant: { capacity: 5, refillPerSec: 1 / 120 } };

function rig(over: { policies?: Partial<typeof DEFAULT_POLICIES>; timeoutMs?: number; store?: BucketStore } = {}) {
  const store = (over.store ?? new MemoryBucketStore()) as MemoryBucketStore;
  const clock = { t: T0 };
  const limiter = createLimiter({ store, now: () => clock.t });
  const { deps } = makeDeps({ t_tenanta01: new MemoryRepo(), t_tenantb02: new MemoryRepo() });
  const logs: Array<Record<string, unknown>> = [];
  const guard = createRequestGuard({
    limiter, auth: async () => deps, verifyPolicies: VPOL, timeoutMs: over.timeoutMs, log: (l) => logs.push(l),
    policies: { ...DEFAULT_POLICIES, 'customer-agent': { capacity: 3, refillPerSec: 1 }, ...over.policies },
  });
  const calls: string[] = [];
  const ok = handle(async () => { calls.push('handler'); return json(200, { ok: true }); }, { guard });
  return { store, clock, limiter, deps, guard, calls, ok, logs };
}

const parse = (r: HttpResult) => JSON.parse(r.body) as Record<string, unknown>;

describe('guard in handle()', () => {
  afterEach(() => setRequestGuard(undefined));

  it('runs before the handler and the handler never runs on a 429', async () => {
    const order: string[] = [];
    const guard: RequestGuard = {
      check: async () => { order.push('guard'); return { allow: false, response: json(429, { code: 'rate_limited' }) }; },
    };
    const h = handle(async () => { order.push('handler'); return json(200, {}); }, { guard });
    const r = await h(voiceEvent({}));
    expect(r.statusCode).toBe(429);
    expect(order).toEqual(['guard']);

    const pass: RequestGuard = { check: async () => { order.push('guard2'); return { allow: true }; } };
    const h2 = handle(async () => { order.push('handler2'); return json(200, {}); }, { guard: pass });
    expect((await h2(voiceEvent({}))).statusCode).toBe(200);
    expect(order).toEqual(['guard', 'guard2', 'handler2']);
  });

  it('applies the installed guard to handlers that pass no options (every existing handler)', async () => {
    const { guard, calls } = rig({ policies: { 'customer-agent': { capacity: 1, refillPerSec: 0.001 } } });
    setRequestGuard(guard);
    const h = handle(async () => { calls.push('handler'); return json(200, { ok: true }); });
    expect((await h(voiceEvent({}))).statusCode).toBe(200);
    expect((await h(voiceEvent({}))).statusCode).toBe(429);
    expect(calls).toEqual(['handler']);
  });

  it('can be turned off per handler', async () => {
    const { guard, calls } = rig({ policies: { 'customer-agent': { capacity: 1, refillPerSec: 0.001 } } });
    setRequestGuard(guard);
    const h = handle(async () => { calls.push('handler'); return json(200, {}); }, { guard: false });
    for (let i = 0; i < 3; i++) expect((await h(voiceEvent({}))).statusCode).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('does nothing when no guard is configured, and the handler behaves as before', async () => {
    const h = handle(async () => json(200, { fine: true }));
    expect(await h(voiceEvent({}))).toMatchObject({ statusCode: 200, body: '{"fine":true}' });
    const bad = handle(async () => { throw new HttpError(409, 'slot_taken', 'taken', 'That time was just taken.'); });
    expect(parse(await bad(voiceEvent({})))).toEqual({ code: 'slot_taken', message: 'taken', sayToCaller: 'That time was just taken.' });
  });

  it('still hides internal errors behind a caller-safe line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = handle(async () => { throw new Error('secret db string'); });
    const r = await h(voiceEvent({}));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secret db string');
    expect(parse(r).sayToCaller).toContain('take a message');
    err.mockRestore();
  });

  it('keeps serving when the guard itself blows up', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guard: RequestGuard = { check: async () => { throw new Error('guard bug'); } };
    const h = handle(async () => json(200, { ok: true }), { guard });
    expect((await h(voiceEvent({}))).statusCode).toBe(200);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('tells the guard how the request ended, including the error code', async () => {
    const seen: unknown[] = [];
    const guard: RequestGuard = { check: async () => ({ allow: true, settled: async (o) => { seen.push(o); } }) };
    await handle(async () => json(201, {}), { guard })(voiceEvent({}));
    await handle(async () => { throw new HttpError(403, 'verification_failed', 'no'); }, { guard })(voiceEvent({}));
    await handle(async () => json(403, { code: 'verification_locked' }), { guard })(voiceEvent({}));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handle(async () => { throw new Error('boom'); }, { guard })(voiceEvent({}));
    vi.restoreAllMocks();
    expect(seen).toEqual([
      { status: 201 }, { status: 403, code: 'verification_failed' }, { status: 403, code: 'verification_locked' }, { status: 500, code: 'internal' },
    ]);
  });

  it('does not fail a request because reporting the outcome failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guard: RequestGuard = { check: async () => ({ allow: true, settled: async () => { throw new Error('ddb down'); } }) };
    expect((await handle(async () => json(200, {}), { guard })(voiceEvent({}))).statusCode).toBe(200);
    err.mockRestore();
  });
});

describe('the 429', () => {
  it('is a 429 with a retry time and a natural line for a customer-facing agent', async () => {
    const { ok, calls } = rig({ policies: { 'customer-agent': { capacity: 1, refillPerSec: 0.5 } } });
    await ok(voiceEvent({}));
    const r = await ok(voiceEvent({}));
    expect(r.statusCode).toBe(429);
    expect(parse(r)).toMatchObject({ code: 'rate_limited', message: expect.any(String), retryAfterSec: 2 });
    expect(r.headers).toMatchObject({ 'content-type': 'application/json', 'retry-after': '2' });
    const say = parse(r).sayToCaller as string;
    expect(checkReply(say, { channel: 'voice' })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('speaks differently to owners and staff than to callers', async () => {
    const { ok } = rig({ policies: { owner: { capacity: 1, refillPerSec: 0.5 } } });
    const claims = { 'custom:tenant_id': 't_tenanta01' };
    const ev: HttpEvent = { headers: {}, requestContext: { requestId: 'r', authorizer: { jwt: { claims } } } };
    await ok(ev);
    const r = await ok(ev);
    expect(r.statusCode).toBe(429);
    expect(RATE_LIMIT_LINES.owner.map((l) => l.sayToCaller)).toContain(parse(r).sayToCaller);
  });

  it('every line passes the style checker clean, and consecutive 429s never repeat a line', async () => {
    for (const l of RATE_LIMIT_LINES.customer) expect(checkReply(l.sayToCaller, { channel: 'voice' })).toEqual([]);
    for (const l of RATE_LIMIT_LINES.owner) expect(checkReply(l.sayToCaller, { channel: 'chat' })).toEqual([]);
    for (const l of RATE_LIMIT_LINES.verification) expect(checkReply(l.sayToCaller, { channel: 'voice' })).toEqual([]);

    const { ok } = rig({ policies: { 'customer-agent': { capacity: 1, refillPerSec: 0.001 } } });
    await ok(voiceEvent({}));
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(parse(await ok(voiceEvent({}))).sayToCaller as string);
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
  });

  it('logs the throttle without any phone number', async () => {
    const { ok, logs } = rig({ policies: { 'customer-agent': { capacity: 1, refillPerSec: 0.001 } } });
    await ok(voiceEvent({}, { caller: '+12145550123' }));
    await ok(voiceEvent({}, { caller: '+12145550123' }));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ msg: 'rate limited', tenantId: 't_tenanta01', principal: 'customer-agent', requestId: 'req-1' });
    expect(JSON.stringify(logs)).not.toContain('2145550123');
  });
});

describe('who gets charged', () => {
  it('charges the tenant and principal from the verified token, never the request body', async () => {
    const { ok, store } = rig();
    await ok(voiceEvent({ tenantId: 't_victim0001', tid: 't_victim0001', tenant: { id: 't_victim0001' } }));
    expect(store.keys()).toEqual(['t_tenanta01|RATE#customer-agent']);
  });

  it('charges the Cognito tenant for dashboard calls, as owner or staff', async () => {
    const { ok, store } = rig();
    const dash = (role?: string): HttpEvent => ({
      headers: {}, requestContext: { requestId: 'r', authorizer: { jwt: { claims: { 'custom:tenant_id': 't_tenantb02', ...(role ? { 'custom:role': role } : {}) } } } },
    });
    await ok(dash());
    await ok(dash('staff'));
    expect(store.keys().sort()).toEqual(['t_tenantb02|RATE#owner', 't_tenantb02|RATE#staff']);
  });

  it('charges the ElevenAgents tenant resolved from the agent id', async () => {
    const { ok, store } = rig();
    await ok({ headers: { 'x-1145-engine-secret': 'engine-secret', 'x-1145-engine-agent-id': 'agent_A' }, requestContext: { requestId: 'r' } });
    expect(store.keys()).toEqual(['t_tenanta01|RATE#customer-agent']);
  });

  it('charges the admin agent on its own bucket', async () => {
    const { ok, store } = rig();
    await ok(voiceEvent({}, { prn: 'admin-agent' }));
    expect(store.keys()).toEqual(['t_tenanta01|RATE#admin-agent']);
  });

  it('lets a request through untouched when nobody can say who it is (the handler answers 401)', async () => {
    const { ok, store, calls } = rig();
    const garbage: HttpEvent = { headers: { authorization: 'Bearer not-a-token' }, requestContext: { requestId: 'r' } };
    const none: HttpEvent = { headers: {}, requestContext: { requestId: 'r' } };
    const wrongEngine: HttpEvent = { headers: { 'x-1145-engine-secret': 'nope', 'x-1145-engine-agent-id': 'agent_A' }, requestContext: { requestId: 'r' } };
    for (const e of [garbage, none, wrongEngine]) expect((await ok(e)).statusCode).toBe(200);
    expect(calls).toHaveLength(3);
    expect(store.reads + store.writes).toBe(0);
  });

  it('does not limit internal service principals, which cannot call tools anyway', async () => {
    const { ok, store, calls } = rig();
    const token = mintTenantToken({ tid: 't_tenanta01', prn: 'system', cid: 'job-1' }, SECRET);
    for (let i = 0; i < 20; i++) expect((await ok({ headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 'r' } })).statusCode).toBe(200);
    expect(calls).toHaveLength(20);
    expect(store.keys()).toEqual([]);
  });

  it('one noisy tenant cannot starve another, and a looping customer agent cannot starve its own owner', async () => {
    const { ok } = rig({ policies: { 'customer-agent': { capacity: 3, refillPerSec: 0.001 } } });
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await ok(voiceEvent({}, { tid: 't_tenanta01' }))).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
    expect((await ok(voiceEvent({}, { tid: 't_tenantb02' }))).statusCode).toBe(200);
    const owner: HttpEvent = { headers: {}, requestContext: { requestId: 'r', authorizer: { jwt: { claims: { 'custom:tenant_id': 't_tenanta01' } } } } };
    expect((await ok(owner)).statusCode).toBe(200);
  });

  it('works in front of a real handler', async () => {
    const { guard } = rig();
    const repo = new MemoryRepo();
    repo.customer = { firstName: 'Dana', hasUpcomingBooking: true };
    const { deps } = makeDeps({ t_tenanta01: repo });
    const h = handle((e) => lookupCaller(e, deps), { guard });
    const r = await h(voiceEvent({}));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ known: true, firstName: 'Dana', hasUpcomingBooking: true });
  });
});

describe('when the store is unhappy', () => {
  it('lets the request through and logs when DynamoDB fails', async () => {
    const { ok, store, logs, calls } = rig();
    store.failWith = new Error('ProvisionedThroughputExceeded');
    expect((await ok(voiceEvent({}))).statusCode).toBe(200);
    expect(calls).toEqual(['handler']);
    expect(logs[0]).toMatchObject({ level: 'error', msg: 'rate limit check failed, letting the request through' });
  });

  it('lets the request through when the store is too slow, within the time budget', async () => {
    const { ok, store, logs } = rig({ timeoutMs: 25 });
    store.hang = true;
    const started = Date.now();
    expect((await ok(voiceEvent({}))).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
    expect(logs[0]).toMatchObject({ msg: 'rate limit check timed out, letting the request through' });
  });
});

// ---- failed caller verification (T1's request) ---------------------------------------------------------------------

describe('failed caller verification across calls', () => {
  const answers = { customerName: 'Okafor', bookedDay: '2026-10-07' };
  const fail = (code = 'verification_failed') => new HttpError(403, code, 'no match', 'Hmm, that does not match.');

  function verifyRig() {
    const r = rig({ policies: { 'customer-agent': { capacity: 1000, refillPerSec: 1000 } } });
    let next: 'fail' | 'ok' | 'other' = 'fail';
    const calls: string[] = [];
    const h = handle(async () => {
      calls.push('handler');
      if (next === 'fail') throw fail();
      if (next === 'other') throw new HttpError(403, 'verification_required', 'need it', 'Before I change anything, what is the name?');
      return json(200, { ok: true });
    }, { guard: r.guard });
    return { ...r, h, calls, mode: (m: typeof next) => { next = m; } };
  }
  const attempt = (caller: string, tid = 't_tenanta01', body: unknown = answers) => voiceEvent(body, { caller, tid });

  it('names the contract with T1', () => {
    expect([...VERIFICATION_FIELDS]).toEqual(['verificationCode', 'customerName', 'bookedDay']);
    expect([...VERIFICATION_FAILURE_CODES]).toEqual(['verification_failed', 'verification_locked']);
  });

  it('locks verification for a caller number after too many misses, across calls', async () => {
    const { h, calls } = verifyRig();
    const first = [];
    for (let i = 0; i < 3; i++) first.push((await h(attempt('+12145550123'))).statusCode);
    expect(first).toEqual([403, 403, 403]);
    const locked = await h(attempt('+12145550123'));
    expect(locked.statusCode).toBe(429);
    expect(parse(locked)).toMatchObject({ code: 'verification_throttled' });
    expect(Number(locked.headers?.['retry-after'])).toBeGreaterThan(0);
    expect(RATE_LIMIT_LINES.verification.map((l) => l.sayToCaller)).toContain(parse(locked).sayToCaller);
    expect(calls).toHaveLength(3); // the guesser never reached the handler again
  });

  it('only gates requests that carry verification answers: taking a message still works', async () => {
    const { h, calls } = verifyRig();
    for (let i = 0; i < 3; i++) await h(attempt('+12145550123'));
    const plain = await h(attempt('+12145550123', 't_tenanta01', { note: 'call me back' }));
    expect(plain.statusCode).toBe(403); // reached the handler (which here always fails), not the lock
    expect(calls).toHaveLength(4);
    expect(parse(plain).code).toBe('verification_failed');
    const withCode = await h(attempt('+12145550123', 't_tenanta01', { verificationCode: '123456' }));
    expect(withCode.statusCode).toBe(429);
  });

  it('does not touch other callers, other tenants or other principals', async () => {
    const { h, calls } = verifyRig();
    for (let i = 0; i < 4; i++) await h(attempt('+12145550123'));
    expect((await h(attempt('+12145550199'))).statusCode).toBe(403); // another caller reaches the handler
    expect((await h(attempt('+12145550123', 't_tenantb02'))).statusCode).toBe(403); // same number, another business
    const admin = voiceEvent(answers, { caller: '+12145550123', prn: 'admin-agent' });
    expect((await h(admin)).statusCode).toBe(403);
    expect(calls).toHaveLength(3 + 3);
  });

  it('counts only real misses: successes and "tell me the name first" do not use up the budget', async () => {
    const { h, mode } = verifyRig();
    mode('ok');
    for (let i = 0; i < 10; i++) expect((await h(attempt('+12145550123'))).statusCode).toBe(200);
    mode('other');
    for (let i = 0; i < 10; i++) expect((await h(attempt('+12145550123'))).statusCode).toBe(403);
    mode('fail');
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push((await h(attempt('+12145550123'))).statusCode);
    expect(outcomes).toEqual([403, 403, 403, 429]); // the full budget of 3 was still there
  });

  it('stops a guesser who rotates caller IDs once the whole business has had too many misses', async () => {
    const { h, calls } = verifyRig();
    const outcomes = [];
    for (let i = 0; i < 7; i++) outcomes.push((await h(attempt(`+1214555010${i}`))).statusCode);
    expect(outcomes).toEqual([403, 403, 403, 403, 403, 429, 429]); // tenant budget is 5
    expect(calls).toHaveLength(5);
    expect((await h(attempt('+12145550123', 't_tenantb02'))).statusCode).toBe(403);
  });

  it('forgives over time', async () => {
    const { h, clock } = verifyRig();
    for (let i = 0; i < 3; i++) await h(attempt('+12145550123'));
    expect((await h(attempt('+12145550123'))).statusCode).toBe(429);
    clock.t += 601_000; // one token back at 1 per 10 minutes
    expect((await h(attempt('+12145550123'))).statusCode).toBe(403);
    expect((await h(attempt('+12145550123'))).statusCode).toBe(429);
  });

  it('never writes the caller number into a key', async () => {
    const { h, store } = verifyRig();
    await h(attempt('+12145550123'));
    expect(store.keys().length).toBeGreaterThan(1);
    expect(store.keys().join(' ')).not.toMatch(/2145550123/);
    expect(store.keys().some((k) => k.startsWith('t_tenanta01|RATE#vfail#'))).toBe(true);
  });

  it('the engine path has no caller id, so only the business-wide budget applies', async () => {
    const { h } = verifyRig();
    const engine = (): HttpEvent => ({
      headers: { 'x-1145-engine-secret': 'engine-secret', 'x-1145-engine-agent-id': 'agent_A' }, body: JSON.stringify(answers), requestContext: { requestId: 'r' },
    });
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push((await h(engine())).statusCode);
    expect(outcomes).toEqual([403, 403, 403, 403, 403, 429]);
  });

  it('counts the per-call lock answer as a miss too', async () => {
    const r = verifyRig();
    const h = handle(async () => { throw fail('verification_locked'); }, { guard: r.guard });
    for (let i = 0; i < 3; i++) expect((await h(attempt('+12145550123'))).statusCode).toBe(403);
    expect((await h(attempt('+12145550123'))).statusCode).toBe(429);
  });
});

// ---- production wiring ---------------------------------------------------------------------------------------------

describe('prodRequestGuard', () => {
  it('stays off without the tenant data role (local runs and tests)', () => {
    expect(prodRequestGuard({})).toBeUndefined();
  });
  it('can be switched off explicitly', () => {
    expect(prodRequestGuard({ TENANT_DATA_ROLE_ARN: 'arn:aws:iam::1:role/x', RATE_LIMIT_DISABLED: '1' })).toBeUndefined();
  });
  it('builds a guard that writes through the tenant-scoped client', async () => {
    const ddb = new FakeDdb();
    const { deps } = makeDeps({});
    const asked: string[] = [];
    const guard = prodRequestGuard(
      { TENANT_DATA_ROLE_ARN: 'arn:aws:iam::1:role/x', TABLE_NAME: 'tbl' },
      { auth: async () => deps, docFor: async (tid) => { asked.push(tid); return scopedDoc(ddb)(tid); } },
    )!;
    expect(guard).toBeDefined();
    const ok = handle(async () => json(200, {}), { guard });
    expect((await ok(voiceEvent({}))).statusCode).toBe(200);
    expect(new Set(asked)).toEqual(new Set(['t_tenanta01'])); // only ever the verified tenant's client
    expect(ddb.sent.find((s) => s.op === 'Put')!.input.TableName).toBe('tbl');
    expect(header(voiceEvent({}), 'authorization')).toBeTruthy();
  });
  it('has a policy for every principal that can reach the tool API', () => {
    for (const p of ['customer-agent', 'admin-agent', 'owner', 'staff'] as const) {
      expect(DEFAULT_POLICIES[p].capacity).toBeGreaterThanOrEqual(10);
      expect(DEFAULT_POLICIES[p].refillPerSec).toBeGreaterThan(0);
    }
  });
});

// keep the Limiter type exercised so a signature change breaks this file, not just the guard
const _typeCheck: (l: Limiter) => Promise<unknown> = (l) => l.take('t', 'b', P3, 1);
void _typeCheck;
