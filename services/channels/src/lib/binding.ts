import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { RouterDeps } from '../router.js';
// The signup stores and the deterministic YES / NO live with the rest of the signup flow (issue D4). The router imports them
// from there so there is one definition of "a plain yes/no from the identity the link was sent to" (CR D4-1, option A).
import {
  answerPendingBinding, createSignupStores, type BindingStore, type ChannelIdentity,
} from '../../../provisioning/src/lib/signup-token.js';

export interface BindingAnswererConfig {
  /** The slice of DynamoDBDocumentClient the signup stores use. */
  doc: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Epoch seconds; tests pass a fixed clock. */
  nowSeconds?: () => number;
}

/** Same rule as the binding key in signup-token.ts and the router's onboarding keys. */
const ONBOARDING_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What provisioning reads on ONBOARDING#<id>/STATE (D1-3 section 2): `confirmed` opens setup, `rejected` keeps it closed. */
const IDENTITY_STATUS = { confirmed: 'confirmed', cancelled: 'rejected' } as const;

const errName = (e: unknown) => (e as { name?: string } | undefined)?.name;

/**
 * True when the write lost on a condition (not pending any more, another identity, window closed, no onboarding record).
 * A transaction cancelled for any other reason (a write race, throttling) is not an answer: it is thrown, so the queue retries
 * the message instead of telling the owner their sign-in timed out.
 */
function lostOnCondition(err: unknown): boolean {
  if (errName(err) === 'ConditionalCheckFailedException') return true;
  if (errName(err) !== 'TransactionCanceledException') return false;
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
  return !reasons || reasons.some((r) => r?.Code === 'ConditionalCheckFailed');
}

/**
 * D4's settle (pending -> confirmed | cancelled, only for the identity the link went to, inside the window), plus the
 * `identityStatus` provisioning gates on, in ONE transaction. Provisioning reads ONBOARDING#<id>/STATE and D4 settles
 * ONBOARDING#<id>/BINDING; writing them apart would let a crash in between leave a confirmed binding behind a closed gate, and
 * the retried YES would then go to the model because nothing is pending any more. The BINDING half is word for word what
 * `createSignupStores().bindings.settle` sends, so D4's reads (`isIdentityConfirmed`) see the same thing.
 */
function settleWithOnboarding(cfg: BindingAnswererConfig): BindingStore['settle'] {
  return async (onboardingId: string, to: 'confirmed' | 'cancelled', who: ChannelIdentity, nowSeconds: number) => {
    if (!ONBOARDING_ID.test(onboardingId)) throw new Error('invalid key segment: onboardingId');
    const PK = `ONBOARDING#${onboardingId}`;
    const at = new Date(nowSeconds * 1000).toISOString();
    // DynamoDB rejects placeholders that no expression uses, so name exactly the timestamp attribute being set.
    const stamp = to === 'confirmed' ? 'confirmedAt' : 'cancelledAt';
    try {
      await cfg.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: cfg.tableName, Key: { PK, SK: 'BINDING' },
              UpdateExpression: `SET #status = :to, #${stamp} = :at`,
              ConditionExpression: '#status = :pending AND #channel = :ch AND #channelUserId = :cu AND #pendingUntil > :now',
              ExpressionAttributeNames: { '#status': 'status', [`#${stamp}`]: stamp, '#channel': 'channel', '#channelUserId': 'channelUserId', '#pendingUntil': 'pendingUntil' },
              ExpressionAttributeValues: { ':to': to, ':pending': 'pending', ':ch': who.channel, ':cu': who.channelUserId, ':now': nowSeconds, ':at': at },
            },
          },
          {
            Update: {
              // Only an onboarding the router created. Never a half-empty record that provisioning would then read as one.
              TableName: cfg.tableName, Key: { PK, SK: 'STATE' },
              UpdateExpression: 'SET #identityStatus = :is, #identityStatusAt = :at',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeNames: { '#identityStatus': 'identityStatus', '#identityStatusAt': 'identityStatusAt' },
              ExpressionAttributeValues: { ':is': IDENTITY_STATUS[to], ':at': at },
            },
          },
        ],
      }));
      return true;
    } catch (err) {
      if (lostOnCondition(err)) return false;
      throw err;
    }
  };
}

/**
 * RouterDeps.answerPendingBinding on top of ONBOARDING#<id>/BINDING and /STATE (SEC-20). Needs GetItem and UpdateItem under the
 * `ONBOARDING#*` leading keys, which the router role already has (a transaction is authorised item by item); no new grant.
 */
export function createBindingAnswerer(cfg: BindingAnswererConfig): NonNullable<RouterDeps['answerPendingBinding']> {
  const { bindings } = createSignupStores({ doc: cfg.doc, tableName: cfg.tableName });
  const store: BindingStore = { get: (onboardingId) => bindings.get(onboardingId), settle: settleWithOnboarding(cfg) };
  return (input) => answerPendingBinding(input, store, cfg.nowSeconds?.());
}
