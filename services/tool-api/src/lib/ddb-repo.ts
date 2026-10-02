import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { keys } from '@1145/shared';
import { IdempotentReplay, SlotTakenError, type BookingRecord, type Service, type TenantRepo } from './repo.js';
import type { BusinessHours } from './slots.js';

const TABLE = process.env.TABLE_NAME ?? 't1145';
const TENANT_ROLE = process.env.TENANT_DATA_ROLE_ARN ?? '';
const RESOURCE = 'default'; // single bookable resource in MVP; per-staff resources in Phase 2
const sts = new STSClient({});
const clients = new Map<string, { doc: DynamoDBDocumentClient; exp: number }>();

/** ADR-0003: credentials whose IAM policy only allows LeadingKeys = TENANT#<tid>. */
async function tenantDoc(tid: string): Promise<DynamoDBDocumentClient> {
  const hit = clients.get(tid);
  if (hit && hit.exp - Date.now() > 60_000) return hit.doc;
  const r = await sts.send(new AssumeRoleCommand({
    RoleArn: TENANT_ROLE, RoleSessionName: `tenant-${tid}`.slice(0, 64), DurationSeconds: 900,
    Tags: [{ Key: 'tenant_id', Value: tid }],
  }));
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('assume role failed');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration },
  }), { marshallOptions: { removeUndefinedValues: true } });
  clients.set(tid, { doc, exp: c.Expiration.getTime() });
  return doc;
}

export async function ddbRepoFor(tid: string): Promise<TenantRepo> {
  const doc = await tenantDoc(tid);
  const pk = keys.tenantPk(tid);
  const get = async (SK: string) => (await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK } }))).Item;

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
          TableName: TABLE, KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
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
        { Put: { TableName: TABLE, Item: { PK: pk, SK: keys.idempotencySk(idempotencyKey), response, ttl }, ConditionExpression: cond } },
        { Put: { TableName: TABLE, Item: { PK: pk, SK: keys.bookingSk(booking.start, booking.bookingId), ...keys.bookingGsi1(tid, booking.bookingId), ...booking }, ConditionExpression: cond } },
        ...slotIsos.map((iso) => ({ Put: { TableName: TABLE, Item: { PK: pk, SK: keys.slotSk(RESOURCE, iso), bookingId: booking.bookingId }, ConditionExpression: cond } })),
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
        TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND GSI1SK = :n',
        ExpressionAttributeValues: { ':p': `${pk}#PHONE`, ':n': e164 }, Limit: 1,
      }));
      const c = r.Items?.[0] as { name?: string; nextBookingAt?: string } | undefined;
      if (!c?.name) return undefined;
      return { firstName: c.name.split(/\s+/)[0] ?? c.name, hasUpcomingBooking: !!c.nextBookingAt && new Date(c.nextBookingAt) > new Date() };
    },
    async putMessage(msg) {
      const id = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: pk, SK: `MSG#${msg.at}#${id}`, ...msg } }));
      return id;
    },
    async getHandoffNumber() { return ((await get(keys.profileSk())) as { handoffNumber?: string } | undefined)?.handoffNumber; },
    async searchVerifiedFacts(query, limit) {
      const r = await doc.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
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
