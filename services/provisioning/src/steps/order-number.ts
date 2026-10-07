import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys } from '@1145/shared';
import { loadTelnyxConfig, telnyxClient, TelnyxRejectedError, TelnyxTransientError, type TelnyxClient, type TelnyxOrder } from '../lib/telnyx.js';

export interface OrderNumberInput { onboardingId: string; tenantId: string; candidates: string[]; connectionId: string }
export interface OrderState {
  get(onboardingId: string): Promise<{ number: string; orderId: string } | undefined>;
  /** The finished purchase. First writer wins; resolves false when one is already on record. */
  put(onboardingId: string, v: { number: string; orderId: string }): Promise<boolean>;
  /**
   * SEC-18. Written BEFORE any money is spent: "this onboarding is about to buy <candidate>". It is what lets a retry tell
   * "never ordered" from "ordered, but the write after it was lost". Throws (so nothing is bought) when it cannot be saved.
   * The three intent methods are optional only so older fakes keep working; production always has all of them.
   */
  begin?(onboardingId: string, candidate: string, now: Date): Promise<void>;
  /** The number an earlier invocation started buying and never recorded an outcome for. */
  pending?(onboardingId: string): Promise<{ candidate: string; at: string } | undefined>;
  /** Forgets the intent after a definite non-purchase (a 4xx), so the next candidate can be tried. */
  release?(onboardingId: string, candidate: string): Promise<void>;
}
/** The lookups are optional only so older fakes keep working; production always has them. */
export type OrderTelnyx = Pick<TelnyxClient, 'order'> & Partial<Pick<TelnyxClient, 'findOrderByReference' | 'findOwnedNumber'>>;

export class NoNumberAvailableError extends Error {
  constructor() { super('NoNumberAvailable'); this.name = 'NoNumberAvailable'; }
}

const reference = (onboardingId: string) => `onb:${onboardingId}`;

/**
 * How long an unfinished attempt is given to show up at the vendor before it is treated as "nothing was bought".
 * The state machine's retries for this step span about 20 s, so a retry that lands inside the window asks again later.
 */
export const SETTLE_AFTER_MS = 15_000;

/**
 * Buys at most one number per onboarding, however many times Step Functions (or a crash) runs this step.
 *
 * Four layers, in order:
 *  1. ORDER# state (DynamoDB conditional put, first writer wins): a finished purchase is returned, never repeated.
 *  2. Telnyx customer_reference `onb:<onboardingId>`: if a run bought the number but died before saving state, or the
 *     response was lost, the order is found at the vendor and adopted instead of buying again.
 *  3. SEC-18, the intent record. Before every order call the candidate is written to ORDER# (`begin`). A later run that
 *     finds such an intent settles it FIRST: the number is on our account (adopt it), or the attempt is young enough that
 *     the vendor's lists may simply be behind (fail so the step is retried), or it is old enough to call it a miss
 *     (release it and order again). Without this, "the state write failed after a successful order" together with
 *     "the order list lags" made the retry order the same number, get refused because we already own it, and move on to
 *     the next candidate: a second purchase.
 *  4. Only a definite rejection (4xx) moves to the next candidate, and only after the intent is released. Any ambiguous
 *     failure (timeout, 5xx, lost response) may already have bought the number, so we look it up and otherwise fail the
 *     step; the retry repeats from 1.
 *
 * Step Functions retries the step only after the previous Lambda invocation has ended, so there is no overlap to
 * serialize; the conditional writes still make a genuine race safe.
 * Card-on-file / deposit is checked by the state machine BEFORE this step (abuse control, D9).
 */
export async function orderNumber(input: OrderNumberInput, deps: { telnyx: OrderTelnyx; state: OrderState; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const existing = await deps.state.get(input.onboardingId);
  if (existing) return existing;

  const ref = reference(input.onboardingId);
  const adopted = await deps.telnyx.findOrderByReference?.(ref);
  if (adopted) return save(input.onboardingId, adopted, deps.state);

  const earlier = await deps.state.pending?.(input.onboardingId);
  if (earlier) {
    const owned = await deps.telnyx.findOwnedNumber?.(earlier.candidate); // a failed lookup throws: never read as "not owned"
    if (owned) return save(input.onboardingId, { orderId: `owned:${owned.id}`, status: 'owned', numbers: [earlier.candidate] }, deps.state);
    if (deps.telnyx.findOwnedNumber && now().getTime() - Date.parse(earlier.at) < SETTLE_AFTER_MS) {
      throw new TelnyxTransientError('an earlier order attempt for this onboarding has not settled yet'); // the workflow retries this name
    }
    await deps.state.release?.(input.onboardingId, earlier.candidate);
  }

  for (const candidate of input.candidates) {
    await deps.state.begin?.(input.onboardingId, candidate, now()); // before any money moves
    let order: { orderId: string; status: string };
    try {
      order = await deps.telnyx.order(candidate, input.connectionId, ref);
    } catch (err) {
      if (err instanceof TelnyxRejectedError) {
        console.warn(JSON.stringify({ level: 'warn', step: 'order-number', onboardingId: input.onboardingId, candidate, reason: 'rejected', status: err.status })); // taken meanwhile: next
        await deps.state.release?.(input.onboardingId, candidate);
        continue;
      }
      // Unknown outcome: the number may have been bought. Never try a different one on this basis.
      const maybe = await deps.telnyx.findOrderByReference?.(ref).catch(() => undefined);
      if (maybe) return save(input.onboardingId, maybe, deps.state);
      console.warn(JSON.stringify({ level: 'warn', step: 'order-number', onboardingId: input.onboardingId, candidate, reason: 'ambiguous', err: String(err) }));
      throw err; // the intent stays: the retry settles it before doing anything else
    }
    return save(input.onboardingId, { orderId: order.orderId, status: order.status, numbers: [candidate] }, deps.state);
  }
  throw new NoNumberAvailableError(); // state machine catches -> failure path (owner is told in plain words)
}

async function save(onboardingId: string, order: TelnyxOrder, state: OrderState): Promise<{ number: string; orderId: string }> {
  const number = order.numbers[0];
  if (!number) throw new Error('telnyx order has no phone number'); // unexpected shape: fail loudly, do not guess
  const v = { number, orderId: order.orderId };
  if (await state.put(onboardingId, v)) return v;
  return (await state.get(onboardingId)) ?? v; // lost the race: the first writer's purchase is the one of record
}

/**
 * ORDER# item lives in the tenant's own partition: PK TENANT#<tid>, SK ORDER#<onboardingId>.
 * Two shapes: the intent (`candidate`, `intentAt`; no `orderId`) and the finished purchase (`number`, `orderId`).
 * `get` only ever returns the finished one, and `put` can replace an intent but never a finished purchase.
 */
export function ddbOrderState(client: { send(cmd: any): Promise<any> }, table: string, tenantId: string): OrderState {
  const key = (onboardingId: string) => ({ PK: keys.tenantPk(asTenantId(tenantId)), SK: `ORDER#${onboardingId}` });
  const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';
  const read = async (onboardingId: string) => (await client.send(new GetCommand({ TableName: table, Key: key(onboardingId), ConsistentRead: true }))).Item as
    { number?: string; orderId?: string; candidate?: string; intentAt?: string } | undefined;
  return {
    async get(onboardingId) {
      const item = await read(onboardingId);
      return item?.number && item.orderId ? { number: item.number, orderId: item.orderId } : undefined;
    },
    async put(onboardingId, v) {
      try {
        await client.send(new PutCommand({
          TableName: table, Item: { ...key(onboardingId), ...v, createdAt: new Date().toISOString() },
          ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(orderId)', // free, or only an intent so far
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },
    async begin(onboardingId, candidate, now) {
      try {
        await client.send(new PutCommand({
          TableName: table, Item: { ...key(onboardingId), candidate, intentAt: now.toISOString() },
          // New, or the same intent again. Another candidate here means an earlier attempt was never settled: the caller settles first.
          ConditionExpression: 'attribute_not_exists(PK) OR (attribute_not_exists(orderId) AND candidate = :c)',
          ExpressionAttributeValues: { ':c': candidate },
        }));
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        const item = await read(onboardingId);
        if (item?.number && item.orderId) return; // the purchase was recorded in the meantime; the caller's next read returns it
        throw new TelnyxTransientError('another order attempt for this onboarding is unsettled'); // retried by the workflow
      }
    },
    async pending(onboardingId) {
      const item = await read(onboardingId);
      return item?.candidate && item.intentAt && !item.orderId ? { candidate: item.candidate, at: item.intentAt } : undefined;
    },
    async release(onboardingId, candidate) {
      try {
        await client.send(new DeleteCommand({
          TableName: table, Key: key(onboardingId),
          ConditionExpression: 'attribute_not_exists(orderId) AND candidate = :c', ExpressionAttributeValues: { ':c': candidate },
        }));
      } catch (err) {
        if (!isConditionFailure(err)) throw err; // already released, or the purchase is on record: nothing to forget
      }
    },
  };
}

/**
 * Step Functions entry. Reads the whole workflow state: onboardingId + tenantId (set server-side by the start
 * endpoint, never by the model) and number.search.candidates from SearchNumber. The connection id comes from our
 * own secret, not from the event.
 */
export async function handler(event: { onboardingId?: string; tenantId?: string; number?: { search?: { candidates?: string[] } } }) {
  const { onboardingId, tenantId } = event;
  const candidates = event.number?.search?.candidates;
  if (!onboardingId || !tenantId || !candidates?.length) throw new Error('order-number needs onboardingId, tenantId and candidates');
  asTenantId(tenantId);
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const cfg = await loadTelnyxConfig();
  return orderNumber(
    { onboardingId, tenantId, candidates, connectionId: cfg.connectionId },
    { telnyx: telnyxClient(cfg.apiKey), state: ddbOrderState(DynamoDBDocumentClient.from(new DynamoDBClient({})), table, tenantId) },
  );
}
