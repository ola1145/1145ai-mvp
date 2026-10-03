import { createHash, randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import type { IdentityRoute, RouterDeps } from '../router.js';
import type { InboundMessage } from './types.js';

/** The slice of DynamoDBDocumentClient we use, so tests can pass a fake. */
export interface DocClient { send(command: unknown): Promise<unknown> }

export interface StoreConfig {
  doc: DocClient;
  tableName: string;
  now?: () => Date;
  newId?: () => string;
}

/** Same pattern as POST /v1/owner-chat/messages and /r/{code} in contracts/openapi/channels.yaml. */
const REFERRAL_CODE = /^[A-Za-z0-9_-]{4,64}$/;
const LEASE_SECONDS = 150;           // a bit under the queue visibility timeout (180 s)
const DEDUP_TTL_SECONDS = 2 * 24 * 3600;

// Keys not yet in contracts/dynamodb/keys.md (see contracts/CHANGE_REQUESTS/C1-1.md).
const onboardingPk = (id: string) => `ONBOARDING#${id}`;
const dedupPk = (msg: Pick<InboundMessage, 'channel' | 'channelUserId' | 'channelMessageId'>) =>
  `MSGDEDUP#${msg.channel}#${createHash('sha256').update(`${msg.channelUserId}\n${msg.channelMessageId}`).digest('hex')}`;

const errName = (e: unknown) => (e as { name?: string })?.name;

type StoreDeps = Pick<RouterDeps, 'lookupIdentity' | 'startOnboarding' | 'claimMessage' | 'completeMessage' | 'releaseMessage'>;

export function createStore(cfg: StoreConfig): StoreDeps {
  const now = cfg.now ?? (() => new Date());
  const newId = cfg.newId ?? (() => `o_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  const TableName = cfg.tableName;
  const nowSec = () => Math.floor(now().getTime() / 1000);

  async function readIdentity(channel: string, channelUserId: string): Promise<Record<string, unknown> | undefined> {
    const r = (await cfg.doc.send(new GetCommand({
      TableName, ConsistentRead: true,
      Key: { PK: keys.identityRoutePk(channel, channelUserId), SK: keys.routeSk() },
    }))) as { Item?: Record<string, unknown> };
    return r.Item;
  }

  const toRoute = (item: Record<string, unknown>): IdentityRoute | undefined => {
    const role = item.role;
    if (role !== 'owner' && role !== 'staff' && role !== 'onboarding') return undefined;
    const state = (item.tenantState ?? item.state) as IdentityRoute['tenantState'];
    return {
      role,
      tid: typeof item.tid === 'string' ? item.tid : undefined,
      onboardingId: typeof item.onboardingId === 'string' ? item.onboardingId : undefined,
      tenantState: state === 'provisioning' || state === 'active' || state === 'suspended' ? state : undefined,
    };
  };

  async function referrerFor(code: string): Promise<string | undefined> {
    const r = (await cfg.doc.send(new GetCommand({ TableName, Key: { PK: `REFERRAL#${code}`, SK: 'OWNER' } }))) as { Item?: Record<string, unknown> };
    const tid = r.Item?.referrerTid ?? r.Item?.tid;
    return typeof tid === 'string' ? tid : undefined;
  }

  return {
    async lookupIdentity(channel, channelUserId) {
      const item = await readIdentity(channel, channelUserId);
      return item ? toRoute(item) : undefined;
    },

    /**
     * Creates the ONBOARDING record and the IDENTITY route in ONE transaction, conditional on the route not existing.
     * Two first messages racing (or a retry) end up with one onboarding: the loser reads the winner's id.
     */
    async startOnboarding(msg) {
      const code = msg.referralCode && REFERRAL_CODE.test(msg.referralCode) ? msg.referralCode : undefined;
      const referrerTid = code ? await referrerFor(code) : undefined;
      const onboardingId = newId();
      const createdAt = now().toISOString();
      const route = { PK: keys.identityRoutePk(msg.channel, msg.channelUserId), SK: keys.routeSk(), role: 'onboarding', onboardingId, createdAt };
      const record = {
        PK: onboardingPk(onboardingId), SK: 'STATE', onboardingId, status: 'started',
        channel: msg.channel, channelUserId: msg.channelUserId,
        ...(msg.displayName ? { displayName: msg.displayName.slice(0, 80) } : {}),
        ...(code ? { referralCode: code } : {}),
        ...(referrerTid ? { referrerTid } : {}),
        createdAt,
      };
      try {
        await cfg.doc.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName, Item: route, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName, Item: record } },
          ],
        }));
        return onboardingId;
      } catch (err) {
        if (errName(err) !== 'TransactionCanceledException' && errName(err) !== 'ConditionalCheckFailedException') throw err;
        const existing = await readIdentity(msg.channel, msg.channelUserId);
        if (typeof existing?.onboardingId === 'string') return existing.onboardingId;
        throw new Error('identity route exists without an onboardingId', { cause: err });
      }
    },

    /** Take the message unless it is already done, or another worker holds an unexpired lease on it. */
    async claimMessage(msg) {
      const t = nowSec();
      try {
        await cfg.doc.send(new PutCommand({
          TableName,
          Item: { PK: dedupPk(msg), SK: 'SEEN', status: 'processing', leaseUntil: t + LEASE_SECONDS, ttl: t + DEDUP_TTL_SECONDS },
          ConditionExpression: 'attribute_not_exists(PK) OR (#st = :processing AND leaseUntil < :now)',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':processing': 'processing', ':now': t },
        }));
        return true;
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async completeMessage(msg) {
      await cfg.doc.send(new UpdateCommand({
        TableName, Key: { PK: dedupPk(msg), SK: 'SEEN' },
        UpdateExpression: 'SET #st = :done, #ttl = :ttl REMOVE leaseUntil',
        ExpressionAttributeNames: { '#st': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':done': 'done', ':ttl': nowSec() + DEDUP_TTL_SECONDS },
      }));
    },

    async releaseMessage(msg) {
      await cfg.doc.send(new DeleteCommand({ TableName, Key: { PK: dedupPk(msg), SK: 'SEEN' } }));
    },
  };
}
