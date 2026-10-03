import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import { createDdbRepo } from '../src/lib/ddb-repo.js';
import { IdempotentReplay, SlotTakenError, type BookingRecord } from '../src/lib/repo.js';

/** Real DynamoDB semantics (transactions, condition checks, GSI) against DynamoDB Local.
 *  Skipped, not faked, when DYNAMODB_LOCAL_ENDPOINT is unset. IAM/ABAC is NOT enforced by DynamoDB Local;
 *  that part is verified in dev (bench/README.md, "Cross-tenant denial"). */
const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
const TABLE = `t1145_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const slot = (m: number) => new Date(Date.UTC(2026, 9, 5, 15, m)).toISOString();
const booking = (id: string, startMin = 0): BookingRecord => ({
  bookingId: id, start: slot(startMin), end: slot(startMin + 30), serviceId: 'cut', status: 'confirmed',
  customer: { name: 'Sam Rivera', phone: '+12145550123' }, via: 'voice', createdAt: '2026-10-02T15:00:00.000Z',
});

describe.skipIf(!endpoint)('ddb-repo against DynamoDB Local', () => {
  let raw: DynamoDBClient;
  let doc: DynamoDBDocumentClient;

  beforeAll(async () => {
    raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
    await raw.send(new CreateTableCommand({
      TableName: TABLE, BillingMode: 'PAY_PER_REQUEST',
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
  });
  afterAll(async () => { await raw?.send(new DeleteTableCommand({ TableName: TABLE })); raw?.destroy(); });

  it('books atomically: booking, slot locks and idempotency record all land', async () => {
    const repo = createDdbRepo(doc, 't_a1', TABLE);
    await repo.book({ booking: booking('bk_1'), slotIsos: [slot(0), slot(15)], idempotencyKey: 'idem-1', response: { ok: true } });
    expect(await repo.getIdempotent('idem-1')).toEqual({ ok: true });
    const locked = await repo.lockedInstants(slot(0), slot(60));
    expect([...locked].sort()).toEqual([slot(0), slot(15)]);
    const byId = await doc.send(new QueryCommand({
      TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND GSI1SK = :s',
      ExpressionAttributeValues: { ':p': 'TENANT#t_a1#BID', ':s': 'bk_1' },
    }));
    expect(byId.Items?.[0]?.bookingId).toBe('bk_1');
  });

  it('rejects an overlapping slot with SlotTakenError and writes nothing from the losing transaction', async () => {
    const repo = createDdbRepo(doc, 't_a2', TABLE);
    await repo.book({ booking: booking('bk_1'), slotIsos: [slot(0), slot(15)], idempotencyKey: 'idem-a', response: 'first' });
    await expect(repo.book({ booking: booking('bk_2', 15), slotIsos: [slot(15), slot(30)], idempotencyKey: 'idem-b', response: 'second' }))
      .rejects.toBeInstanceOf(SlotTakenError);
    expect(await repo.getIdempotent('idem-b')).toBeUndefined();
    expect([...(await repo.lockedInstants(slot(0), slot(60)))].sort()).toEqual([slot(0), slot(15)]);
  });

  it('replays an idempotent retry: IdempotentReplay, stored response intact, no extra lock', async () => {
    const repo = createDdbRepo(doc, 't_a3', TABLE);
    await repo.book({ booking: booking('bk_1'), slotIsos: [slot(0)], idempotencyKey: 'idem-r', response: { bookingId: 'bk_1' } });
    await expect(repo.book({ booking: booking('bk_9', 90), slotIsos: [slot(90)], idempotencyKey: 'idem-r', response: { bookingId: 'bk_9' } }))
      .rejects.toBeInstanceOf(IdempotentReplay);
    expect(await repo.getIdempotent('idem-r')).toEqual({ bookingId: 'bk_1' });
    expect((await repo.lockedInstants(slot(60), slot(120))).size).toBe(0);
  });

  it('lets exactly one of several concurrent bookings for the same slot win', async () => {
    const repo = createDdbRepo(doc, 't_a4', TABLE);
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) =>
      repo.book({ booking: booking(`bk_${n}`), slotIsos: [slot(0)], idempotencyKey: `idem-c${n}`, response: n })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SlotTakenError);
  });

  it('keeps tenants apart: same slot and idempotency key in two tenants never collide or leak', async () => {
    const a = createDdbRepo(doc, 't_ia', TABLE);
    const b = createDdbRepo(doc, 't_ib', TABLE);
    await a.book({ booking: booking('bk_a'), slotIsos: [slot(0)], idempotencyKey: 'same-key', response: 'A' });
    await b.book({ booking: booking('bk_b'), slotIsos: [slot(0)], idempotencyKey: 'same-key', response: 'B' });
    expect(await a.getIdempotent('same-key')).toBe('A');
    expect(await b.getIdempotent('same-key')).toBe('B');
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: keys.tenantPk('t_ib'), SK: keys.slotSk('default', slot(45)), bookingId: 'x' } }));
    expect((await a.lockedInstants(slot(30), slot(60))).size).toBe(0);
  });

  it('reads hours, default service, handoff number and handoff window from the tenant partition', async () => {
    const pk = keys.tenantPk('t_prof');
    const hours = { timezone: 'America/Chicago', weekly: [{ day: 1, open: '09:00', close: '17:00' }] };
    const window = { timezone: 'America/Chicago', weekly: [{ day: 1, open: '10:00', close: '12:00' }] };
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: keys.hoursSk(), ...hours } }));
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: keys.serviceSk('cut'), serviceId: 'cut', name: 'Haircut', durationMin: 30, active: true } }));
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: keys.profileSk(), defaultServiceId: 'cut', handoffNumber: '+12145550199', handoffWindow: window } }));
    const repo = createDdbRepo(doc, 't_prof', TABLE);
    expect((await repo.getHours())?.weekly).toEqual(hours.weekly);
    expect((await repo.defaultService())?.name).toBe('Haircut');
    expect(await repo.getHandoffNumber()).toBe('+12145550199');
    expect(await repo.getHandoffWindow()).toEqual(window);
    expect(await createDdbRepo(doc, 't_none', TABLE).getHandoffWindow()).toBeUndefined();
  });

  it('finds a customer by phone through GSI1 and returns the first name only', async () => {
    const pk = keys.tenantPk('t_cust');
    await doc.send(new PutCommand({ TableName: TABLE, Item: {
      PK: pk, SK: keys.customerSk('c1'), GSI1PK: `${pk}#PHONE`, GSI1SK: '+12145550123', name: 'Sam Rivera',
      nextBookingAt: new Date(Date.now() + 86_400_000).toISOString(),
    } }));
    const repo = createDdbRepo(doc, 't_cust', TABLE);
    expect(await repo.findCustomerByPhone('+12145550123')).toEqual({ firstName: 'Sam', hasUpcomingBooking: true });
    expect(await repo.findCustomerByPhone('+12145550000')).toBeUndefined();
    expect(await createDdbRepo(doc, 't_other', TABLE).findCustomerByPhone('+12145550123')).toBeUndefined();
  });

  it('saves messages and ranks the tenant\'s facts by term overlap', async () => {
    const pk = keys.tenantPk('t_kb');
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: keys.factSk('f1'), text: 'We are closed on Sundays', source: 'owner', verified: true } }));
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: keys.factSk('f2'), text: 'Parking is free behind the shop', source: 'site', verified: false } }));
    const repo = createDdbRepo(doc, 't_kb', TABLE);
    const hits = await repo.searchVerifiedFacts('closed sundays', 3);
    expect(hits.map((h) => h.text)).toEqual(['We are closed on Sundays']);
    const id = await repo.putMessage({ fromName: 'Jo', body: 'Call me back', urgency: 'normal', at: '2026-10-02T15:00:00.000Z' });
    expect(id).toMatch(/^msg_/);
  });
});
