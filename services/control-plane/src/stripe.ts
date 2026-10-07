/**
 * Stripe: signature check, event parsing and the billing rules. Pure functions, no I/O (owner: H1).
 *
 * Billing is deterministic rules, not an agent (Change-12). Stripe Smart Retries owns the retry schedule; we only
 * react to its outcomes. Nothing in a Stripe object is ever treated as an instruction, and none of its free text
 * (names, emails, descriptions, metadata) is copied anywhere: only the typed facts in `billingFacts`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ───────────────────────── signature ─────────────────────────
const HEX_SHA256_RE = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;

/**
 * Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>]"; the signed payload is `${t}.${rawBody}`.
 * `rawBody` must be the exact bytes Stripe sent: re-serialised JSON never verifies.
 * `secret` may be a list so an old and a new endpoint secret both work while one is being rotated.
 * Constant-time comparison; only the full 64-character digest is accepted.
 */
export function verifyStripeSignature(
  rawBody: string | Uint8Array,
  header: string | undefined,
  secret: string | readonly string[],
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const pairs = header.split(',').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? ([p.trim(), ''] as const) : ([p.slice(0, i).trim(), p.slice(i + 1).trim()] as const);
  });
  const t = pairs.find(([k]) => k === 't')?.[1] ?? '';
  if (!TIMESTAMP_RE.test(t) || Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const secrets = (typeof secret === 'string' ? [secret] : secret).filter((s) => s.length > 0);
  const given = pairs.filter(([k, v]) => k === 'v1' && HEX_SHA256_RE.test(v)).map(([, v]) => Buffer.from(v, 'hex'));
  if (!secrets.length || !given.length) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const signed = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]);
  let ok = false;
  for (const s of secrets) {
    const expected = createHmac('sha256', s).update(signed).digest();
    for (const g of given) if (timingSafeEqual(g, expected)) ok = true;
  }
  return ok;
}

// ───────────────────────── events ─────────────────────────
/** The fields we read from an event, after the signature is verified. `object` is `data.object`, kept as data. */
export interface StripeEvent {
  id: string;
  type: string;
  /** Unix seconds when Stripe created the event. Stripe does not promise delivery in this order. */
  created: number;
  livemode: boolean;
  object: Record<string, unknown>;
}

export class StripePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripePayloadError';
  }
}

const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,100}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{1,100}$/;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9_]{1,100}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export const isStripeCustomerId = (v: unknown): v is string => typeof v === 'string' && CUSTOMER_ID_RE.test(v);

/** Call only after `verifyStripeSignature` passed. Throws StripePayloadError for anything that is not a Stripe event. */
export function parseStripeEvent(raw: string): StripeEvent {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new StripePayloadError('not json'); }
  if (!isRecord(v)) throw new StripePayloadError('not an object');
  const { id, type, created, livemode, data } = v;
  if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) throw new StripePayloadError('bad event id');
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) throw new StripePayloadError('bad event type');
  if (typeof created !== 'number' || !Number.isInteger(created) || created <= 0) throw new StripePayloadError('bad created');
  if (typeof livemode !== 'boolean') throw new StripePayloadError('bad livemode');
  if (!isRecord(data) || !isRecord(data.object)) throw new StripePayloadError('no data.object');
  return { id, type, created, livemode, object: data.object };
}

/** The Stripe customer an event is about. Only a plain `cus_...` string counts; expanded objects and junk do not. */
export function customerIdOf(event: StripeEvent): string | undefined {
  const c = event.object.customer;
  return isStripeCustomerId(c) ? c : undefined;
}

// ───────────────────────── rules ─────────────────────────
export const BILLING_REASON = 'billing';
/** Matches the `actor` description in contracts/events: "Ops user sub, 'billing', or 'system'". */
export const BILLING_ACTOR = 'billing';

export type BillingAction = { kind: 'none' } | { kind: 'notify_owner'; template: string } | { kind: 'set_state'; state: 'active' | 'suspended' };

/** Deterministic rules, not an agent (Change-12). Stripe Smart Retries handles the retry schedule. */
export function actionForStripeEvent(type: string, obj: { status?: string }): BillingAction {
  switch (type) {
    case 'invoice.payment_failed': return { kind: 'notify_owner', template: 'billing_payment_failed' };
    case 'invoice.paid': return { kind: 'set_state', state: 'active' };
    case 'customer.subscription.deleted': return { kind: 'set_state', state: 'suspended' };
    case 'customer.subscription.updated':
      return obj.status === 'unpaid' || obj.status === 'canceled' ? { kind: 'set_state', state: 'suspended' } : { kind: 'none' };
    default: return { kind: 'none' };
  }
}

/** Event types that change billing state. Everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES = ['invoice.paid', 'invoice.payment_failed', 'customer.subscription.deleted', 'customer.subscription.updated'] as const;

export const isHandledEventType = (type: string): boolean => (HANDLED_EVENT_TYPES as readonly string[]).includes(type);

/** What Stripe says about the customer's billing, kept on the profile next to (never instead of) the runtime state. */
export type BillingStatus = 'active' | 'past_due' | 'unpaid' | 'canceled';

const statusOf = (obj: Record<string, unknown>): string | undefined => (typeof obj.status === 'string' ? obj.status : undefined);

export function billingStatusFor(type: string, obj: { status?: unknown }): BillingStatus | undefined {
  switch (type) {
    case 'invoice.paid': return 'active';
    case 'invoice.payment_failed': return 'past_due';
    case 'customer.subscription.deleted': return 'canceled';
    case 'customer.subscription.updated':
      switch (obj.status) {
        case 'active': case 'trialing': return 'active';
        case 'past_due': return 'past_due';
        case 'unpaid': return 'unpaid';
        case 'canceled': return 'canceled';
        default: return undefined;
      }
    default: return undefined;
  }
}

/** The part of the tenant profile the rules look at. */
export interface BillingTenantView {
  state?: string;
  stateReasonCode?: string;
}

export interface BillingPlan {
  billingStatus: BillingStatus | undefined;
  /** The runtime state billing wants, when it differs from what the tenant has. */
  stateTarget: 'active' | 'suspended' | undefined;
  /** Why a state change that the event asked for is NOT being made. */
  kept: 'already_suspended' | 'suspended_for_other_reason' | undefined;
  /** Owner notice template to send, if any. */
  notify: string | undefined;
}

/**
 * SEC-29: billing only clears suspensions billing caused, and never replaces another reason.
 *  - invoice paid: a `billing` suspension is lifted. An abuse/ops suspension stays. `over_cap` is usage, not billing.
 *  - subscription gone or unpaid: suspends a live tenant. A tenant already suspended keeps its original reason, so a
 *    later payment cannot lift it.
 */
export function planBilling(event: StripeEvent, tenant: BillingTenantView): BillingPlan {
  const action = actionForStripeEvent(event.type, { status: statusOf(event.object) });
  const current = tenant.state ?? 'active';
  let stateTarget: BillingPlan['stateTarget'];
  let kept: BillingPlan['kept'];
  if (action.kind === 'set_state') {
    if (action.state === 'suspended') {
      if (current === 'suspended') kept = 'already_suspended';
      else stateTarget = 'suspended';
    } else if (current === 'suspended') {
      if (tenant.stateReasonCode === BILLING_REASON) stateTarget = 'active';
      else kept = 'suspended_for_other_reason';
    }
  }
  return {
    billingStatus: billingStatusFor(event.type, event.object),
    stateTarget,
    kept,
    notify: action.kind === 'notify_owner' ? action.template : undefined,
  };
}

const intOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e12 ? v : undefined);

/** Typed facts only, for the audit entry. No names, emails, descriptions or metadata ever come through here. */
export function billingFacts(event: StripeEvent): Record<string, number | string> {
  const o = event.object;
  const out: Record<string, number | string> = {};
  const put = (k: string, v: number | string | undefined) => { if (v !== undefined) out[k] = v; };
  if (typeof o.id === 'string' && /^(in|sub)_[A-Za-z0-9_]{1,100}$/.test(o.id)) put('objectId', o.id);
  const status = statusOf(o);
  if (status && /^[a-z_]{1,30}$/.test(status)) put('stripeStatus', status);
  put('attemptCount', intOf(o.attempt_count));
  put('amountDue', intOf(o.amount_due));
  put('amountPaid', intOf(o.amount_paid));
  put('nextPaymentAttempt', intOf(o.next_payment_attempt));
  if (typeof o.currency === 'string' && /^[a-z]{3}$/.test(o.currency)) put('currency', o.currency);
  return out;
}
