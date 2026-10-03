import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDdbRepo, createTenantDocProvider, type TenantCredentials } from '../src/lib/ddb-repo.js';
import { IdempotentReplay, SlotTakenError, type BookingRecord } from '../src/lib/repo.js';

// These are unit tests with a stubbed client (no DynamoDB). They cover credential caching and the mapping of
// transaction failures; real transaction semantics live in ddb-repo.local.test.ts (DynamoDB Local).

const asDoc = (send: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) =>
  ({ send: async (cmd: never) => send(cmd) }) as unknown as DynamoDBDocumentClient;

const booking: BookingRecord = {
  bookingId: 'bk_1', start: '2026-10-05T15:00:00.000Z', end: '2026-10-05T15:30:00.000Z', serviceId: 'cut', status: 'confirmed',
  customer: { name: 'Sam' }, via: 'voice', createdAt: '2026-10-02T15:00:00.000Z',
};
const bookInput = { booking, slotIsos: ['2026-10-05T15:00:00.000Z', '2026-10-05T15:15:00.000Z'], idempotencyKey: 'k1', response: {} };
const cancelled = (...codes: string[]) => Object.assign(new Error('tx'), {
  name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })),
});

describe('createDdbRepo transaction failures', () => {
  it('maps a failed idempotency condition to IdempotentReplay', async () => {
    const repo = createDdbRepo(asDoc(() => { throw cancelled('ConditionalCheckFailed', 'None', 'None', 'None'); }), 't_a1', 'tbl');
    await expect(repo.book(bookInput)).rejects.toBeInstanceOf(IdempotentReplay);
  });
  it('maps a failed slot condition to SlotTakenError', async () => {
    const repo = createDdbRepo(asDoc(() => { throw cancelled('None', 'None', 'None', 'ConditionalCheckFailed'); }), 't_a1', 'tbl');
    await expect(repo.book(bookInput)).rejects.toBeInstanceOf(SlotTakenError);
  });
  it('lets throttling and other cancellations through untouched so the handler can say so', async () => {
    const repo = createDdbRepo(asDoc(() => { throw cancelled('None', 'None', 'ThrottlingError', 'None'); }), 't_a1', 'tbl');
    await expect(repo.book(bookInput)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
  });
  it('puts the idempotency record first, so a replay is reported before a slot conflict', async () => {
    let items: Array<{ Put: { Item: { SK: string } } }> = [];
    const repo = createDdbRepo(asDoc((cmd) => { items = (cmd.input.TransactItems as typeof items); return {}; }), 't_a1', 'tbl');
    await repo.book(bookInput);
    expect(items.map((i) => i.Put.Item.SK.split('#')[0])).toEqual(['IDEMP', 'BOOKING', 'SLOT', 'SLOT']);
  });
});

describe('createDdbRepo tenant scoping', () => {
  it('addresses only the constructed tenant partition on every read and write', async () => {
    const seen: string[] = [];
    const doc = asDoc((cmd) => {
      const i = cmd.input as { Key?: { PK: string }; Item?: { PK: string }; ExpressionAttributeValues?: Record<string, string>; TransactItems?: Array<{ Put: { Item: { PK: string } } }> };
      if (i.Key) seen.push(i.Key.PK);
      if (i.Item) seen.push(i.Item.PK);
      if (i.ExpressionAttributeValues?.[':pk']) seen.push(i.ExpressionAttributeValues[':pk']);
      for (const t of i.TransactItems ?? []) seen.push(t.Put.Item.PK);
      return { Items: [] };
    });
    const repo = createDdbRepo(doc, 't_zz9', 'tbl');
    await repo.getHours(); await repo.getService('cut'); await repo.defaultService(); await repo.lockedInstants('a', 'b');
    await repo.getIdempotent('k'); await repo.book(bookInput); await repo.putMessage({ fromName: 'x', body: 'y', urgency: 'low', at: 'z' });
    await repo.getHandoffNumber(); await repo.getHandoffWindow(); await repo.searchVerifiedFacts('hello there', 2);
    expect(seen.length).toBeGreaterThan(8);
    expect(new Set(seen)).toEqual(new Set(['TENANT#t_zz9']));
  });
  it('refuses a tenant id that could widen the IAM policy or break key parsing', () => {
    for (const bad of ['', 't#1', 't_*', 'a'.repeat(65), 'a b']) {
      expect(() => createDdbRepo(asDoc(() => ({})), bad, 'tbl')).toThrow(/tenant id/);
    }
  });
});

describe('createTenantDocProvider credential caching', () => {
  const T0 = 1_000_000;
  function setup(over: { maxEntries?: number; fail?: boolean } = {}) {
    let clock = T0;
    const calls: string[] = [];
    const provider = createTenantDocProvider({
      assumeRole: async (tid): Promise<TenantCredentials> => {
        calls.push(tid);
        await Promise.resolve();
        if (over.fail && calls.length === 1) throw new Error('sts down');
        return { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiration: new Date(clock + 900_000) };
      },
      makeDoc: (_creds, tid) => ({ tid }) as unknown as DynamoDBDocumentClient,
      now: () => clock,
      maxEntries: over.maxEntries,
    });
    return { provider, calls, advance: (ms: number) => { clock += ms; } };
  }

  it('assumes the role once for concurrent first calls of one tenant', async () => {
    const { provider, calls } = setup();
    const docs = await Promise.all([provider('t_a1'), provider('t_a1'), provider('t_a1')]);
    expect(calls).toEqual(['t_a1']);
    expect(docs[0]).toBe(docs[1]);
  });
  it('reuses the client until 60 s before expiry, then refreshes', async () => {
    const { provider, calls, advance } = setup();
    const first = await provider('t_a1');
    advance(800_000);
    expect(await provider('t_a1')).toBe(first);
    advance(50_000);
    expect(await provider('t_a1')).not.toBe(first);
    expect(calls).toEqual(['t_a1', 't_a1']);
  });
  it('never shares a client between tenants', async () => {
    const { provider, calls } = setup();
    const a = await provider('t_a1');
    const b = await provider('t_b2');
    expect(a).not.toBe(b);
    expect(calls).toEqual(['t_a1', 't_b2']);
  });
  it('does not cache a failed assume-role', async () => {
    const { provider, calls } = setup({ fail: true });
    await expect(provider('t_a1')).rejects.toThrow('sts down');
    await expect(provider('t_a1')).resolves.toBeDefined();
    expect(calls).toHaveLength(2);
  });
  it('rejects a bad tenant id before calling STS', async () => {
    const { provider, calls } = setup();
    await expect(provider('t_*')).rejects.toThrow(/tenant id/);
    expect(calls).toHaveLength(0);
  });
  it('keeps the cache bounded by evicting the oldest tenant', async () => {
    const { provider, calls } = setup({ maxEntries: 2 });
    await provider('t_a1'); await provider('t_b2'); await provider('t_c3');
    await provider('t_a1');
    expect(calls).toEqual(['t_a1', 't_b2', 't_c3', 't_a1']);
  });
});
