import { createHash } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import type { NotifyEventType, NotifyPrefs, NotifyStore, OwnerChannel, OwnerTargets, PushSubscriptionRecord, TenantInfo } from './types.js';
import { NOTIFY_EVENT_TYPES } from './types.js';

/**
 * Reads and writes the few items notifications needs, all under TENANT#<tid> (see contracts/CHANGE_REQUESTS/C6-1.md):
 *   PROFILE            name, timezone
 *   SERVICE#<sid>      name
 *   MEMBER#<sub>       role, email, phone, identities[{channel, id}]   (owner contact details)
 *   NOTIFY#PREFS       events, quietHours, urgentCall, urgentCallInQuietHours
 *   NOTIFY#PUSH#<h>    endpoint, p256dh, auth                          (written by the owner app's subscribe call)
 *   NOTIF#<event>#<channel>#<h>   dedupe claim, TTL 7 days
 * The tenant id comes from the event envelope on the bus, never from event text.
 */
export interface DynamoStoreOptions {
  db: Pick<DynamoDBDocumentClient, 'send'>;
  table: string;
  now?: () => Date;
}

const DEDUPE_TTL_SECONDS = 7 * 24 * 3600;
const CHANNELS: OwnerChannel[] = ['telegram', 'email', 'push'];
const hash = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);

/** Where a push subscription lives; shared with whatever stores subscriptions so removal finds it. */
export const pushSubscriptionSk = (endpoint: string) => `NOTIFY#PUSH#${hash(endpoint, 24)}`;

function validTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

function cleanPrefs(item: Record<string, unknown> | undefined): NotifyPrefs {
  if (!item) return {};
  const prefs: NotifyPrefs = {};
  const ev = item.events;
  if (ev && typeof ev === 'object') {
    const events: Partial<Record<NotifyEventType, OwnerChannel[]>> = {};
    for (const t of NOTIFY_EVENT_TYPES) {
      const v = (ev as Record<string, unknown>)[t];
      if (Array.isArray(v)) events[t] = v.filter((c): c is OwnerChannel => CHANNELS.includes(c as OwnerChannel));
    }
    prefs.events = events;
  }
  const q = item.quietHours as { start?: unknown; end?: unknown } | null | undefined;
  if (q && typeof q.start === 'string' && typeof q.end === 'string') prefs.quietHours = { start: q.start, end: q.end };
  if (typeof item.urgentCall === 'boolean') prefs.urgentCall = item.urgentCall;
  if (typeof item.urgentCallInQuietHours === 'boolean') prefs.urgentCallInQuietHours = item.urgentCallInQuietHours;
  return prefs;
}

export function createDynamoStore(o: DynamoStoreOptions): NotifyStore {
  const now = o.now ?? (() => new Date());
  const { db, table } = o;
  const pk = (tid: string) => keys.tenantPk(tid);
  const query = async (tid: string, prefix: string) =>
    ((await db.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk(tid), ':sk': prefix },
      Limit: 50,
    }))) as { Items?: Array<Record<string, unknown>> }).Items ?? [];
  const get = async (tid: string, sk: string) =>
    ((await db.send(new GetCommand({ TableName: table, Key: { PK: pk(tid), SK: sk } }))) as { Item?: Record<string, unknown> }).Item;
  const claimSk = (eventId: string, key: string) => {
    const i = key.indexOf(':');
    const channel = i < 0 ? key : key.slice(0, i);
    return `NOTIF#${eventId.replace(/#/g, '_')}#${channel}#${hash(key, 12)}`;
  };

  return {
    async getTenant(tid): Promise<TenantInfo> {
      const p = await get(tid, keys.profileSk());
      return { name: typeof p?.name === 'string' && p.name ? p.name : 'your business', timezone: validTimezone(p?.timezone) };
    },

    async getPrefs(tid) {
      return cleanPrefs(await get(tid, 'NOTIFY#PREFS'));
    },

    async getTargets(tid): Promise<OwnerTargets> {
      const [members, pushItems] = await Promise.all([query(tid, 'MEMBER#'), query(tid, 'NOTIFY#PUSH#')]);
      const owners = members.filter((m) => m.role === 'owner');
      const telegram = new Set<string>();
      const emails = new Set<string>();
      let phone: string | undefined;
      for (const m of owners) {
        for (const id of Array.isArray(m.identities) ? (m.identities as Array<{ channel?: unknown; id?: unknown }>) : []) {
          if (id.channel === 'telegram' && (typeof id.id === 'string' || typeof id.id === 'number')) telegram.add(String(id.id));
        }
        if (typeof m.email === 'string' && m.email.includes('@')) emails.add(m.email.trim().toLowerCase());
        if (!phone && typeof m.phone === 'string') phone = m.phone;
      }
      const pushSubscriptions: PushSubscriptionRecord[] = pushItems.flatMap((i) =>
        typeof i.endpoint === 'string' && typeof i.p256dh === 'string' && typeof i.auth === 'string'
          ? [{ endpoint: i.endpoint, p256dh: i.p256dh, auth: i.auth }] : []);
      return { telegramChatIds: [...telegram], emails: [...emails], ...(phone ? { phone } : {}), pushSubscriptions };
    },

    async getServiceName(tid, serviceId) {
      let sk: string;
      try { sk = keys.serviceSk(serviceId); } catch { return undefined; }
      const s = await get(tid, sk);
      return typeof s?.name === 'string' ? s.name : undefined;
    },

    async claim(tid, eventId, key) {
      try {
        await db.send(new PutCommand({
          TableName: table,
          Item: { PK: pk(tid), SK: claimSk(eventId, key), ttl: Math.floor(now().getTime() / 1000) + DEDUPE_TTL_SECONDS },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    async release(tid, eventId, key) {
      await db.send(new DeleteCommand({ TableName: table, Key: { PK: pk(tid), SK: claimSk(eventId, key) } }));
    },

    async removePushSubscription(tid, endpoint) {
      await db.send(new DeleteCommand({ TableName: table, Key: { PK: pk(tid), SK: pushSubscriptionSk(endpoint) } }));
    },
  };
}
