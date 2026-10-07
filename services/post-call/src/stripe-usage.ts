/**
 * Report billable seconds to Stripe metered billing (idempotency key = callId).
 * Owner: issue G2 (tasks/G2.md).
 *
 * Each call is one Stripe billing meter event whose `identifier` and `Idempotency-Key` are both the call id, so a retry
 * or a replayed call.ended can never bill a call twice. Stripe only dedupes within 24 hours, so a ledger item
 * (`IDEMP#stripe:<callId>`, written after Stripe accepts) covers the long tail; if we crash between Stripe accepting
 * and the ledger write, the retry sends the same key and Stripe hands back the original event.
 *
 * Rules this file keeps:
 *  - Test mode only until the account is activated (ADR-0005): `assertStripeTestKey` refuses a live key unless the
 *    caller opts in explicitly. Tests use a fake behind `StripeUsageClient`; nothing here calls Stripe on import.
 *  - Which Stripe customer is billed comes from the tenant's own profile (`stripeCustomerId`), looked up by the
 *    envelope's tenant id. It is never an input to `reportStripeUsage`.
 *  - A tenant with no Stripe customer yet (a trial) is skipped, not billed and not an error.
 *  - Billable seconds are reported as the meter value; the included minutes and the per-minute price live in the
 *    Stripe price (tiered), not in this code.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { asTenantId, keys, type TenantId } from '@1145/shared';
import { MAX_CALL_SECONDS, assertCallId, guardTtl, isConditionalFailure, replayGuardSk, toDate, type TenantDocProvider } from './usage-store.js';

/** `event_name` of the Stripe billing meter that sums billable seconds (payload key `value`, customer key `stripe_customer_id`). */
export const STRIPE_METER_EVENT_NAME = 'voice_seconds';
/** Stripe accepts meter event times within the past 35 days; stay a day inside that. */
export const STRIPE_WINDOW_DAYS = 34;

const CUSTOMER_ID = /^cus_[A-Za-z0-9]{3,64}$/;
const TEST_KEY = /^(?:sk|rk)_test_[A-Za-z0-9_]+$/;
const LIVE_KEY = /^(?:sk|rk)_live_[A-Za-z0-9_]+$/;

/** Throws unless `key` is a test-mode secret or restricted key. Live keys need `allowLive`. The key is never echoed. */
export function assertStripeTestKey(key: string, opts: { allowLive?: boolean } = {}): void {
  if (TEST_KEY.test(key)) return;
  if (opts.allowLive && LIVE_KEY.test(key)) return;
  throw new Error('Stripe usage reporting runs in test mode only until the account is activated: expected an sk_test_ or rk_test_ key');
}

// ───────────────────────────── Stripe client port ─────────────────────────────

export interface MeterEventInput {
  eventName: string;
  stripeCustomerId: string;
  /** Billable seconds. */
  value: number;
  /** Stripe-side dedupe id for the event: the call id. */
  identifier: string;
  /** Sent as the Idempotency-Key header: the call id. */
  idempotencyKey: string;
  timestampSec: number;
}

export interface StripeUsageClient {
  /** Returns the meter event's id. The same idempotency key always returns the same event. */
  reportSeconds(input: MeterEventInput): Promise<{ id: string }>;
}

/** The slice of the Stripe SDK this module uses, so a fake can stand in and the real `Stripe` instance still fits. */
export interface StripeMeterSdk {
  billing: {
    meterEvents: {
      create(
        params: { event_name: string; payload: { [key: string]: string }; identifier?: string; timestamp?: number },
        options?: { idempotencyKey?: string },
      ): Promise<{ identifier: string }>;
    };
  };
}

export function stripeMeterClient(sdk: StripeMeterSdk): StripeUsageClient {
  return {
    async reportSeconds(i) {
      const event = await sdk.billing.meterEvents.create(
        {
          event_name: i.eventName,
          payload: { stripe_customer_id: i.stripeCustomerId, value: String(i.value) },
          identifier: i.identifier,
          timestamp: i.timestampSec,
        },
        { idempotencyKey: i.idempotencyKey },
      );
      return { id: event.identifier };
    },
  };
}

/** The production client. Refuses a live key unless `allowLive` is set. Building it makes no network call. */
export function createStripeUsageClient(secretKey: string, opts: { allowLive?: boolean } = {}): StripeUsageClient {
  assertStripeTestKey(secretKey, opts);
  return stripeMeterClient(new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 10_000 }));
}

// ───────────────────────────── lookups and ledger ─────────────────────────────

export interface StripeCustomerLookup {
  /** The tenant's Stripe customer id from its profile, or undefined before a card is on file. */
  stripeCustomerFor(tenantId: TenantId): Promise<string | undefined>;
}

export interface UsageLedger {
  findReport(tenantId: TenantId, callId: string): Promise<{ meterEventId: string } | undefined>;
  recordReport(tenantId: TenantId, callId: string, meterEventId: string): Promise<void>;
}

export interface DdbBillingStoreConfig {
  docFor: TenantDocProvider;
  table: string;
  now?: () => number;
}

export function createDdbBillingStore(cfg: DdbBillingStoreConfig): StripeCustomerLookup & UsageLedger {
  const now = cfg.now ?? Date.now;
  return {
    async stripeCustomerFor(tenantId) {
      const doc = await cfg.docFor(tenantId);
      const r = await doc.send(new GetCommand({
        TableName: cfg.table, Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
        ProjectionExpression: '#customer', ExpressionAttributeNames: { '#customer': 'stripeCustomerId' },
      }));
      const id = r.Item?.stripeCustomerId;
      return typeof id === 'string' ? id : undefined;
    },

    async findReport(tenantId, callId) {
      const doc = await cfg.docFor(tenantId);
      const r = await doc.send(new GetCommand({ TableName: cfg.table, Key: { PK: keys.tenantPk(tenantId), SK: replayGuardSk('stripe', callId) } }));
      return r.Item ? { meterEventId: String(r.Item.meterEventId ?? '') } : undefined;
    },

    async recordReport(tenantId, callId, meterEventId) {
      const doc = await cfg.docFor(tenantId);
      try {
        await doc.send(new PutCommand({
          TableName: cfg.table,
          Item: { PK: keys.tenantPk(tenantId), SK: replayGuardSk('stripe', callId), meterEventId, ttl: guardTtl(now()) },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      } catch (err) {
        if (!isConditionalFailure(err)) throw err; // already recorded by a concurrent delivery
      }
    },
  };
}

// ───────────────────────────── reporting ─────────────────────────────

export interface StripeUsageDeps {
  stripe: StripeUsageClient;
  customers: StripeCustomerLookup;
  ledger: UsageLedger;
  now?: () => Date;
  /** Override the meter's event name. Default: `voice_seconds`. */
  eventName?: string;
}

export interface StripeUsageInput {
  /** From the call.ended envelope. */
  tenantId: string;
  callId: string;
  billableSeconds: number;
  /** When the call ended. */
  at: Date | string;
}

export type StripeUsageResult =
  | { status: 'reported'; meterEventId: string }
  | { status: 'duplicate'; meterEventId?: string }
  | { status: 'skipped'; reason: 'no_billable_seconds' | 'no_stripe_customer' };

export async function reportStripeUsage(input: StripeUsageInput, deps: StripeUsageDeps): Promise<StripeUsageResult> {
  const tenantId = asTenantId(input.tenantId);
  assertCallId(input.callId);
  const seconds = input.billableSeconds;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_CALL_SECONDS) throw new RangeError('implausible call length');
  const when = toDate(input.at);
  if (Math.round(seconds) === 0) return { status: 'skipped', reason: 'no_billable_seconds' };

  const customer = await deps.customers.stripeCustomerFor(tenantId);
  if (!customer || !CUSTOMER_ID.test(customer)) return { status: 'skipped', reason: 'no_stripe_customer' };

  const prior = await deps.ledger.findReport(tenantId, input.callId);
  if (prior) return { status: 'duplicate', ...(prior.meterEventId ? { meterEventId: prior.meterEventId } : {}) };

  const nowSec = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const atSec = Math.floor(when.getTime() / 1000);
  // Stripe rejects events older than 35 days or from the future. Late usage is billed in the current window, not lost.
  const timestampSec = Math.min(nowSec, Math.max(atSec, nowSec - STRIPE_WINDOW_DAYS * 86_400));

  const sent = await deps.stripe.reportSeconds({
    eventName: deps.eventName ?? STRIPE_METER_EVENT_NAME,
    stripeCustomerId: customer,
    value: Math.round(seconds),
    identifier: input.callId,
    idempotencyKey: input.callId,
    timestampSec,
  });
  await deps.ledger.recordReport(tenantId, input.callId, sent.id);
  return { status: 'reported', meterEventId: sent.id };
}

/**
 * Binds the call and its end time from the event; the tenant comes from the handler's argument (the envelope's tenant id).
 * Call it right after the usage counter, with the same billable seconds.
 */
export function makeReportStripeUsage(callId: string, at: Date | string, deps: StripeUsageDeps) {
  return (tenantId: string, billableSeconds: number): Promise<StripeUsageResult> => reportStripeUsage({ tenantId, callId, billableSeconds, at }, deps);
}
