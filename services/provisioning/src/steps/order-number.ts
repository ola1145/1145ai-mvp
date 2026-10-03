import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys } from '@1145/shared';
import { loadTelnyxConfig, telnyxClient, TelnyxRejectedError, type TelnyxClient, type TelnyxOrder } from '../lib/telnyx.js';

export interface OrderNumberInput { onboardingId: string; tenantId: string; candidates: string[]; connectionId: string }
export interface OrderState { get(onboardingId: string): Promise<{ number: string; orderId: string } | undefined>; put(onboardingId: string, v: { number: string; orderId: string }): Promise<boolean> }
/** `findOrderByReference` is optional only so older fakes keep working; production always has it. */
export type OrderTelnyx = Pick<TelnyxClient, 'order'> & Partial<Pick<TelnyxClient, 'findOrderByReference'>>;

export class NoNumberAvailableError extends Error {
  constructor() { super('NoNumberAvailable'); this.name = 'NoNumberAvailable'; }
}

const reference = (onboardingId: string) => `onb:${onboardingId}`;

/**
 * Buys at most one number per onboarding, however many times Step Functions (or a crash) runs this step.
 *
 * Three layers, in order:
 *  1. ORDER# state (DynamoDB conditional put, first writer wins): a finished purchase is returned, never repeated.
 *  2. Telnyx customer_reference `onb:<onboardingId>`: if a run bought the number but died before saving state, or the
 *     response was lost, the order is found at the vendor and adopted instead of buying again.
 *  3. Only a definite rejection (4xx) moves to the next candidate. Any ambiguous failure (timeout, 5xx, lost response)
 *     may already have bought the number, so we look it up and otherwise fail the step; the retry repeats from 1.
 *
 * Step Functions retries the step only after the previous Lambda invocation has ended, so there is no overlap to
 * serialize; the conditional put still makes a genuine race safe.
 * Card-on-file / deposit is checked by the state machine BEFORE this step (abuse control, D9).
 */
export async function orderNumber(input: OrderNumberInput, deps: { telnyx: OrderTelnyx; state: OrderState }) {
  const existing = await deps.state.get(input.onboardingId);
  if (existing) return existing;

  const ref = reference(input.onboardingId);
  const adopted = await deps.telnyx.findOrderByReference?.(ref);
  if (adopted) return save(input.onboardingId, adopted, deps.state);

  for (const candidate of input.candidates) {
    let order: { orderId: string; status: string };
    try {
      order = await deps.telnyx.order(candidate, input.connectionId, ref);
    } catch (err) {
      if (err instanceof TelnyxRejectedError) {
        console.warn(JSON.stringify({ level: 'warn', step: 'order-number', onboardingId: input.onboardingId, candidate, reason: 'rejected', status: err.status })); // taken meanwhile: next
        continue;
      }
      // Unknown outcome: the number may have been bought. Never try a different one on this basis.
      const maybe = await deps.telnyx.findOrderByReference?.(ref).catch(() => undefined);
      if (maybe) return save(input.onboardingId, maybe, deps.state);
      console.warn(JSON.stringify({ level: 'warn', step: 'order-number', onboardingId: input.onboardingId, candidate, reason: 'ambiguous', err: String(err) }));
      throw err;
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

/** ORDER# item lives in the tenant's own partition: PK TENANT#<tid>, SK ORDER#<onboardingId>. */
export function ddbOrderState(client: { send(cmd: any): Promise<any> }, table: string, tenantId: string): OrderState {
  const key = (onboardingId: string) => ({ PK: keys.tenantPk(asTenantId(tenantId)), SK: `ORDER#${onboardingId}` });
  return {
    async get(onboardingId) {
      const r = await client.send(new GetCommand({ TableName: table, Key: key(onboardingId), ConsistentRead: true }));
      const item = r.Item as { number?: string; orderId?: string } | undefined;
      return item?.number && item.orderId ? { number: item.number, orderId: item.orderId } : undefined;
    },
    async put(onboardingId, v) {
      try {
        await client.send(new PutCommand({ TableName: table, Item: { ...key(onboardingId), ...v, createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(PK)' }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
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
