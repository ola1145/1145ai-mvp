import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { keys } from '@1145/shared';
import { IdempotentReplay, SlotTakenError, type BookingRecord, type Service, type TenantRepo } from './repo.js';
import type { BusinessHours } from './slots.js';

const TABLE = process.env.TABLE_NAME ?? 't1145';
const RESOURCE = 'default'; // single bookable resource in MVP; per-staff resources in Phase 2
/** Tenant ids become an IAM session tag and a key prefix: keep them boring (no wildcard, no '#', no spaces). */
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const assertTenantId = (tid: string) => { if (!TENANT_ID.test(tid)) throw new Error('invalid tenant id'); };

export interface TenantCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }

export interface TenantDocProviderOptions {
  assumeRole(tid: string): Promise<TenantCredentials>;
  makeDoc(creds: TenantCredentials, tid: string): DynamoDBDocumentClient;
  now?: () => number;
  /** Refresh this long before the credentials expire. Default 60 s. */
  refreshMarginMs?: number;
  /** Upper bound on warm tenants per container; oldest is evicted first. Default 200. */
  maxEntries?: number;
}

/** ADR-0003 credential cache. One AssumeRole per tenant per ~14 minutes per warm container, concurrent first calls
 *  share the same in-flight request, failures are never cached, and a client is never shared across tenants. */
export function createTenantDocProvider(opts: TenantDocProviderOptions): (tid: string) => Promise<DynamoDBDocumentClient> {
  const now = opts.now ?? Date.now;
  const margin = opts.refreshMarginMs ?? 60_000;
  const max = opts.maxEntries ?? 200;
  const cache = new Map<string, { doc: Promise<DynamoDBDocumentClient>; exp: number }>();

  return async (tid) => {
    assertTenantId(tid);
    const hit = cache.get(tid);
    if (hit && hit.exp - now() > margin) return hit.doc;
    cache.delete(tid);
    // exp is unknown until STS answers; use Infinity so concurrent callers share the in-flight promise.
    const entry = { doc: undefined as unknown as Promise<DynamoDBDocumentClient>, exp: Number.POSITIVE_INFINITY };
    entry.doc = opts.assumeRole(tid).then((creds) => {
      entry.exp = creds.expiration.getTime();
      return opts.makeDoc(creds, tid);
    });
    cache.set(tid, entry);
    while (cache.size > max) cache.delete(cache.keys().next().value as string);
    try {
      return await entry.doc;
    } catch (err) {
      if (cache.get(tid) === entry) cache.delete(tid);
      throw err;
    }
  };
}

let sts: STSClient | undefined;
const prodProvider = createTenantDocProvider({
  assumeRole: async (tid) => {
    const roleArn = process.env.TENANT_DATA_ROLE_ARN;
    if (!roleArn) throw new Error('TENANT_DATA_ROLE_ARN is not set');
    sts ??= new STSClient({});
    const r = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn, RoleSessionName: `tenant-${tid}`.slice(0, 64), DurationSeconds: 900, // 900 s is the STS minimum
      Tags: [{ Key: 'tenant_id', Value: tid }],
    }));
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('assume role failed');
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  },
  makeDoc: (c) => DynamoDBDocumentClient.from(new DynamoDBClient({ credentials: c }), { marshallOptions: { removeUndefinedValues: true } }),
});

/** The production repo: credentials come from AssumeRole with a tenant_id session tag, so IAM itself refuses
 *  any key outside TENANT#<tid>. */
export async function ddbRepoFor(tid: string): Promise<DdbTenantRepo> {
  return createDdbRepo(await prodProvider(tid), tid);
}

export type DdbTenantRepo = TenantRepo & { getHandoffWindow(): Promise<BusinessHours | undefined> };

/** Repo over any DocumentClient. Production passes the ABAC-scoped client above; DynamoDB Local tests pass their own. */
export function createDdbRepo(doc: DynamoDBDocumentClient, tid: string, table: string = TABLE): DdbTenantRepo {
  assertTenantId(tid);
  const pk = keys.tenantPk(tid);
  const get = async (SK: string) => (await doc.send(new GetCommand({ TableName: table, Key: { PK: pk, SK } }))).Item;

  return {
    async getHours() { return (await get(keys.hoursSk())) as BusinessHours | undefined; },
    async getService(id) { const i = await get(keys.serviceSk(id)); return i as Service | undefined; },
    async defaultService() {
      const p = (await get(keys.profileSk())) as { defaultServiceId?: string } | undefined;
      return p?.defaultServiceId ? ((await get(keys.serviceSk(p.defaultServiceId))) as Service | undefined) : undefined;
    },
    async lockedInstants(fromIso, toIso) {
      const out = new Set<string>();
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': pk, ':a': keys.slotSk(RESOURCE, fromIso), ':b': keys.slotSk(RESOURCE, toIso) },
          ProjectionExpression: 'SK', ExclusiveStartKey,
        }));
        for (const it of r.Items ?? []) out.add(String(it.SK).split('#').slice(2).join('#'));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async getIdempotent(key) { return (await get(keys.idempotencySk(key)))?.response; },
    async book({ booking, slotIsos, idempotencyKey, response }) {
      const ttl = Math.floor(Date.now() / 1000) + 86_400;
      const cond = 'attribute_not_exists(PK)';
      const items = [
        { Put: { TableName: table, Item: { PK: pk, SK: keys.idempotencySk(idempotencyKey), response, ttl }, ConditionExpression: cond } },
        { Put: { TableName: table, Item: { PK: pk, SK: keys.bookingSk(booking.start, booking.bookingId), ...keys.bookingGsi1(tid, booking.bookingId), ...booking }, ConditionExpression: cond } },
        ...slotIsos.map((iso) => ({ Put: { TableName: table, Item: { PK: pk, SK: keys.slotSk(RESOURCE, iso), bookingId: booking.bookingId }, ConditionExpression: cond } })),
      ];
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (err) {
        const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
        if (e.name === 'TransactionCanceledException') {
          const reasons = e.CancellationReasons ?? [];
          if (reasons[0]?.Code === 'ConditionalCheckFailed') throw new IdempotentReplay();
          if (reasons.slice(2).some((r) => r.Code === 'ConditionalCheckFailed')) throw new SlotTakenError();
        }
        throw err;
      }
    },
    async findCustomerByPhone(e164) {
      const r = await doc.send(new QueryCommand({
        TableName: table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND GSI1SK = :n',
        ExpressionAttributeValues: { ':p': `${pk}#PHONE`, ':n': e164 }, Limit: 1,
      }));
      const c = r.Items?.[0] as { name?: string; nextBookingAt?: string } | undefined;
      if (!c?.name) return undefined;
      return { firstName: c.name.split(/\s+/)[0] ?? c.name, hasUpcomingBooking: !!c.nextBookingAt && new Date(c.nextBookingAt) > new Date() };
    },
    async putMessage(msg) {
      const id = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await doc.send(new PutCommand({ TableName: table, Item: { PK: pk, SK: `MSG#${msg.at}#${id}`, ...msg } }));
      return id;
    },
    async getHandoffWindow() { return ((await get(keys.profileSk())) as { handoffWindow?: BusinessHours } | undefined)?.handoffWindow; },
    async getHandoffNumber() { return ((await get(keys.profileSk())) as { handoffNumber?: string } | undefined)?.handoffNumber; },
    async searchVerifiedFacts(query, limit) {
      const r = await doc.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
        ExpressionAttributeValues: { ':pk': pk, ':f': 'FACT#' },
      }));
      const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      return (r.Items ?? [])
        .map((it) => ({ text: String(it.text), source: String(it.source), verified: it.verified === true }))
        .map((p) => ({ p, score: terms.filter((t) => p.text.toLowerCase().includes(t)).length }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
    },
  };
}

export type { BookingRecord };
