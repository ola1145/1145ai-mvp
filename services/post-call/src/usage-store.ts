/**
 * Atomic monthly usage counter; flip number route to over_cap at the cap.
 * Owner: issue G2 (tasks/G2.md).
 *
 * What this file guarantees:
 *  - One call is counted once, however many times its call.ended event is delivered. The counter bump and a per-call
 *    guard item (`IDEMP#usage:<callId>`) go into one DynamoDB transaction, so either both land or neither does.
 *  - The month total is a DynamoDB ADD on `USAGE#<yyyy-mm>`, so calls ending at the same moment never lose an increment.
 *  - The month is the UTC month the call ended in (from the event time), so a replay lands in the same bucket.
 *  - Crossing the cap moves the tenant's NUMBER# routes and its profile from `active` to `over_cap` and emits one
 *    `tenant.state_changed`. The profile flip is conditional, so exactly one caller wins and emits. Routes move first and
 *    the move is idempotent, so a replay repairs a half-finished flip. A suspension is never overridden by the cap.
 *  - The tenant id is the one on the event envelope. It is validated here and used for every key; nothing read from the
 *    transcript, the analysis or the request body can change it. Tenant data goes through `docFor(tenantId)`, which in
 *    production is the ABAC-scoped client (ADR-0003); only the route items use the separate `routeDoc`.
 */
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, makeEvent, type EventEnvelope, type TenantId, type TenantRuntimeState } from '@1145/shared';
import type { PostCallDeps } from './handler.js';
import { capState } from './usage.js';

/** Returns a DynamoDB client allowed to touch `TENANT#<tenantId>` only. Production: the AssumeRole-with-tag client. */
export type TenantDocProvider = (tenantId: string) => DynamoDBDocumentClient | Promise<DynamoDBDocumentClient>;

/** Seconds a tenant may use per month when its profile carries no `capSec`: the 30 free minutes of a trial. */
export const DEFAULT_CAP_SEC = 30 * 60;
/** Calls are capped far below this (E3). Anything longer in an event is bad data, not a long call. */
export const MAX_CALL_SECONDS = 4 * 60 * 60;
/** How long a per-call guard item lives. Longer than any retry window and longer than Stripe's 35-day event window. */
export const REPLAY_GUARD_TTL_SEC = 45 * 86_400;
export const OVER_CAP_REASON = 'minutes_cap';

const CALL_ID = /^[A-Za-z0-9_.:+=@-]{1,128}$/;

/** Call ids come from the engine. They end up in key names, so keep them boring. */
export function assertCallId(callId: unknown): asserts callId is string {
  if (typeof callId !== 'string' || !CALL_ID.test(callId)) throw new Error('invalid call id');
}

/** `IDEMP#<kind>:<callId>`: one guard item per call and side effect. A conditional put on it says "already done". */
export const replayGuardSk = (kind: 'usage' | 'crm' | 'stripe', callId: string): string => keys.idempotencySk(`${kind}:${callId}`);

export const guardTtl = (nowMs: number): number => Math.floor(nowMs / 1000) + REPLAY_GUARD_TTL_SEC;

/** Normalizes the event time to a Date or throws; a call with no usable end time cannot be filed under a month. */
export function toDate(at: Date | string): Date {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RangeError('invalid call time');
  return d;
}

/** `yyyy-mm`, UTC. */
export function usageMonth(at: Date | string): string {
  const d = toDate(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';
}

/** Per-item reason codes of a cancelled transaction, or undefined when `err` is something else. */
export function cancellationCodes(err: unknown): string[] | undefined {
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> } | undefined;
  if (e?.name !== 'TransactionCanceledException') return undefined;
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
}

// ───────────────────────────── store port ─────────────────────────────

export interface TenantBilling {
  state: TenantRuntimeState;
  capSec?: number;
  /** E.164 numbers the tenant owns (their NUMBER# routes). */
  numbers: string[];
}

export interface UsageStore {
  /** Add `seconds` for `callId` once. A replay changes nothing and reports `replayed: true`. `usedSec` is the month total after. */
  addOnce(tenantId: TenantId, o: { month: string; callId: string; seconds: number; at: string }): Promise<{ replayed: boolean; usedSec: number }>;
  getTenant(tenantId: TenantId): Promise<TenantBilling | undefined>;
  /** Move this tenant's number routes from active to over_cap. Safe to repeat; never touches a route that is not active or not theirs. */
  overCapRoutes(tenantId: TenantId, numbers: readonly string[]): Promise<void>;
  /** Conditionally move the profile from active to over_cap. True only for the caller that actually changed it. */
  markOverCap(tenantId: TenantId, o: { at: string; reasonCode: string; actor: string }): Promise<boolean>;
}

export interface DdbUsageStoreConfig {
  docFor: TenantDocProvider;
  /** Client allowed to update NUMBER# route items (they sit outside every tenant's partition). */
  routeDoc: DynamoDBDocumentClient;
  table: string;
  now?: () => number;
}

const STATES: readonly string[] = ['active', 'suspended', 'over_cap'];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSACTION_ATTEMPTS = 6;

export function createDdbUsageStore(cfg: DdbUsageStoreConfig): UsageStore {
  const now = cfg.now ?? Date.now;
  const TableName = cfg.table;

  return {
    async addOnce(tenantId, o) {
      const doc = await cfg.docFor(tenantId);
      const PK = keys.tenantPk(tenantId);
      const usageKey = { PK, SK: keys.usageSk(o.month) };
      let replayed = false;
      for (let attempt = 1; ; attempt++) {
        try {
          await doc.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName, Key: usageKey,
                  UpdateExpression: 'SET #updatedAt = :at ADD #seconds :seconds, #calls :one',
                  ExpressionAttributeNames: { '#updatedAt': 'updatedAt', '#seconds': 'billableSeconds', '#calls': 'callCount' },
                  ExpressionAttributeValues: { ':at': o.at, ':seconds': o.seconds, ':one': 1 },
                },
              },
              {
                Put: {
                  TableName,
                  Item: { PK, SK: replayGuardSk('usage', o.callId), month: o.month, seconds: o.seconds, at: o.at, ttl: guardTtl(now()) },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          }));
          break;
        } catch (err) {
          const codes = cancellationCodes(err);
          if (codes?.[1] === 'ConditionalCheckFailed') { replayed = true; break; } // this call is already counted
          if (codes?.includes('TransactionConflict') && attempt < TRANSACTION_ATTEMPTS) { await sleep(10 * attempt); continue; }
          throw err;
        }
      }
      // Strongly consistent read after the write: the total includes this call (and any that landed alongside it).
      const total = await doc.send(new GetCommand({
        TableName, Key: usageKey, ConsistentRead: true,
        ProjectionExpression: '#seconds', ExpressionAttributeNames: { '#seconds': 'billableSeconds' },
      }));
      return { replayed, usedSec: Number(total.Item?.billableSeconds ?? 0) };
    },

    async getTenant(tenantId) {
      const doc = await cfg.docFor(tenantId);
      const r = await doc.send(new GetCommand({ TableName, Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() }, ConsistentRead: true }));
      const p = r.Item;
      if (!p) return undefined;
      // A state this code does not know is treated as an ops state: never overridden.
      const state: TenantRuntimeState = p.state === undefined ? 'active' : STATES.includes(String(p.state)) ? (p.state as TenantRuntimeState) : 'suspended';
      const cap = typeof p.capSec === 'number' && Number.isFinite(p.capSec) && p.capSec >= 0 ? p.capSec : undefined;
      const numbers = Array.isArray(p.numbers) ? p.numbers.filter((n): n is string => typeof n === 'string') : [];
      return { state, ...(cap !== undefined ? { capSec: cap } : {}), numbers };
    },

    async overCapRoutes(tenantId, numbers) {
      for (const n of numbers) {
        let PK: string;
        try { PK = keys.numberRoutePk(n); } catch { continue; } // malformed number on the profile: nothing to flip
        try {
          await cfg.routeDoc.send(new UpdateCommand({
            TableName,
            Key: { PK, SK: keys.routeSk() },
            UpdateExpression: 'SET #state = :over',
            // Only this tenant's own route, and only out of `active`: a number handed to someone else, or one ops
            // suspended, is left exactly as it is.
            ConditionExpression: '#tid = :tid AND (attribute_not_exists(#state) OR #state = :active)',
            ExpressionAttributeNames: { '#state': 'state', '#tid': 'tid' },
            ExpressionAttributeValues: { ':over': 'over_cap', ':active': 'active', ':tid': tenantId },
          }));
        } catch (err) {
          if (!isConditionalFailure(err)) throw err;
        }
      }
    },

    async markOverCap(tenantId, o) {
      const doc = await cfg.docFor(tenantId);
      try {
        await doc.send(new UpdateCommand({
          TableName,
          Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
          UpdateExpression: 'SET #state = :over, #reason = :reason, #actor = :actor, #at = :at',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(#state) OR #state = :active)',
          ExpressionAttributeNames: { '#state': 'state', '#reason': 'stateReasonCode', '#actor': 'stateActor', '#at': 'stateUpdatedAt' },
          ExpressionAttributeValues: { ':over': 'over_cap', ':active': 'active', ':reason': o.reasonCode, ':actor': o.actor, ':at': o.at },
        }));
        return true;
      } catch (err) {
        if (isConditionalFailure(err)) return false;
        throw err;
      }
    },
  };
}

// ───────────────────────────── recording a call ─────────────────────────────

export interface RecordUsageInput {
  /** From the call.ended envelope, never from the transcript or the model. */
  tenantId: string;
  callId: string;
  seconds: number;
  /** When the call ended (the event's time). Picks the month. */
  at: Date | string;
}

export interface UsageDeps {
  store: UsageStore;
  publish(e: EventEnvelope): Promise<void>;
  now?: () => Date;
}

export interface RecordUsageResult {
  month: string;
  /** Month total after this call. */
  usedSec: number;
  capSec: number;
  /** Month total before this call. Approximate when other calls ended at the same moment. Unknown on a replay. */
  previousUsedSec?: number;
  replayed: boolean;
  /** Set only on the call that crosses 80% or 100% of the cap, for the owner's "running low" and "used up" notices. */
  crossed?: 80 | 100;
  /** True when this call moved the tenant to over_cap (and emitted tenant.state_changed). */
  stateChanged: boolean;
}

export function crossedThreshold(previousSec: number, usedSec: number, capSec: number): 80 | 100 | undefined {
  if (usedSec >= capSec && previousSec < capSec) return 100;
  if (usedSec < capSec && usedSec >= capSec * 0.8 && previousSec < capSec * 0.8) return 80;
  return undefined;
}

export async function recordCallUsage(input: RecordUsageInput, deps: UsageDeps): Promise<RecordUsageResult> {
  const tenantId = asTenantId(input.tenantId);
  assertCallId(input.callId);
  if (!Number.isFinite(input.seconds) || input.seconds < 0 || input.seconds > MAX_CALL_SECONDS) throw new RangeError('implausible call length');
  const seconds = Math.round(input.seconds);
  const when = toDate(input.at);
  const month = usageMonth(when);

  const { replayed, usedSec } = await deps.store.addOnce(tenantId, { month, callId: input.callId, seconds, at: when.toISOString() });
  const tenant = await deps.store.getTenant(tenantId);
  const capSec = tenant?.capSec ?? DEFAULT_CAP_SEC;

  // Evaluated on replays too: if the first attempt died between counting and flipping, this one finishes the job.
  let stateChanged = false;
  if (tenant && tenant.state === 'active' && capState(usedSec, capSec) === 'over') {
    await deps.store.overCapRoutes(tenantId, tenant.numbers);
    const flippedAt = deps.now?.() ?? new Date();
    if (await deps.store.markOverCap(tenantId, { at: flippedAt.toISOString(), reasonCode: OVER_CAP_REASON, actor: 'system' })) {
      stateChanged = true;
      await deps.publish(
        makeEvent('tenant.state_changed', { tenantId, correlationId: input.callId }, { state: 'over_cap', previousState: 'active', reasonCode: OVER_CAP_REASON, actor: 'system' }, flippedAt),
      );
    }
  }

  const previousUsedSec = replayed ? undefined : Math.max(0, usedSec - seconds);
  const crossed = previousUsedSec === undefined ? undefined : crossedThreshold(previousUsedSec, usedSec, capSec);
  return {
    month, usedSec, capSec, replayed, stateChanged,
    ...(previousUsedSec !== undefined ? { previousUsedSec } : {}),
    ...(crossed !== undefined ? { crossed } : {}),
  };
}

/**
 * Adapter for PostCallDeps.addUsage: binds the call and its end time from the event. The tenant comes from the
 * handler's argument, which is the envelope's tenant id.
 */
export function makeAddUsage(callId: string, at: Date | string, deps: UsageDeps): PostCallDeps['addUsage'] {
  return (tenantId, seconds) => recordCallUsage({ tenantId, callId, seconds, at }, deps);
}
