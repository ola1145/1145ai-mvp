/**
 * Stripe webhook Lambda (POST /stripe/webhook, no authorizer: the signature is the credential). Owner: issue H1.
 *
 * Flow, in this order, and each step is a rule rather than a judgement:
 *  1. Read the raw bytes (base64-decoded if API Gateway encoded them). Nothing is parsed yet.
 *  2. Verify the Stripe signature over those exact bytes with the signing secret from Secrets Manager.
 *     Wrong, missing or stale: 400, and nothing else runs (no parsing, no storage).
 *  3. Parse the event. A live event on a test endpoint (or the reverse) is refused.
 *  4. Event types we do not act on are acknowledged and dropped.
 *  5. Claim the event id in the ledger (STRIPEEVT#<id>). A finished id is a duplicate: 200 and no work. An id another
 *     delivery is still working on gets 409 so Stripe tries again later. Only a verified event id is ever claimed.
 *  6. Map the Stripe customer to a tenant from OUR record (STRIPECUST#<customerId>). Never from event metadata.
 *  7. Apply the rules in stripe.ts: audit entry first, billing marker, then `setTenantState` (engine, then profile)
 *     and the `tenant.state_changed` event. Stale (out-of-order) events are dropped.
 *  8. Mark the event done. Any failure releases the claim and answers 500 so Stripe retries.
 *
 * Reason code is always `billing` and the actor is always `billing`; neither comes from the request.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { asTenantId, keys, makeEvent, type EngineAgentRef, type EventEnvelope, type TenantRuntimeState, type VoiceEngine } from '@1145/shared';
import { auditWriter, type AuditEntry } from './audit.js';
import { consoleEngineFor } from './console/engines.js';
import { DdbConsoleStore } from './console/store.js';
import { engineRefFromProfile, setTenantState } from './set-tenant-state.js';
import {
  BILLING_ACTOR, BILLING_REASON, StripePayloadError, billingFacts, customerIdOf, isHandledEventType, isStripeCustomerId,
  parseStripeEvent, planBilling, verifyStripeSignature, type BillingStatus, type StripeEvent,
} from './stripe.js';

// ───────────────────────── types ─────────────────────────
/** The slice of an API Gateway HTTP API (payload 2.0) event the webhook reads. */
export interface WebhookRequest {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
}

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type ClaimResult = 'claimed' | 'done' | 'in_progress';

export type TenantProfile = Record<string, unknown>;

/** Persistence for the webhook. Customer and event lookups are by key, so no tenant data is ever scanned. */
export interface BillingStore {
  /** Atomic: only the first caller for an id (or the first after a lease expires) gets 'claimed'. */
  claimEvent(eventId: string, type: string, nowSec: number): Promise<ClaimResult>;
  completeEvent(eventId: string, outcome: string, nowSec: number): Promise<void>;
  /** Frees an unfinished claim so Stripe's retry can run straight away. A finished event is left alone. */
  releaseEvent(eventId: string): Promise<void>;
  /** The tenant id our own record holds for a Stripe customer. */
  tenantForCustomer(customerId: string): Promise<string | undefined>;
  getProfile(tenantId: string): Promise<TenantProfile | undefined>;
  /** Moves the billing marker forward in time only. 'stale' means a newer event was already recorded. */
  recordBilling(tenantId: string, rec: { status?: BillingStatus; eventId: string; eventAt: number }): Promise<'recorded' | 'stale'>;
  writeState(tenantId: string, state: TenantRuntimeState, meta: { reasonCode: string; actor: string; at: string }): Promise<void>;
}

export interface WebhookDeps {
  /** Endpoint signing secrets. More than one while a secret is being rotated. */
  secrets(): Promise<readonly string[]>;
  /** Which Stripe mode this deployment accepts. Dev is test mode only. */
  expectLivemode: boolean;
  store: BillingStore;
  engineFor(ref: EngineAgentRef): VoiceEngine;
  /** Must throw if the entry did not land. */
  audit(entry: AuditEntry): Promise<void>;
  emit(event: EventEnvelope): Promise<void>;
  /** Optional seam for the owner notice on a failed payment (see contracts/CHANGE_REQUESTS/H1-3.md). Best effort. */
  notifyOwner?(tenantId: string, template: string, eventId: string): Promise<void>;
  now(): Date;
}

// ───────────────────────── handler ─────────────────────────
const MAX_BODY_BYTES = 512 * 1024;
const TOLERANCE_SEC = 300;

function respond(statusCode: number, body: Record<string, unknown>): WebhookResponse {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

function headerOf(req: WebhookRequest, name: string): string | undefined {
  for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function handleStripeWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  // 1. Raw bytes. Nothing is parsed until the signature has been checked.
  const signature = headerOf(req, 'stripe-signature');
  if (typeof req.body !== 'string' || !signature) return respond(400, { error: 'invalid_signature' });
  const raw = req.isBase64Encoded ? Buffer.from(req.body, 'base64') : Buffer.from(req.body, 'utf8');
  if (raw.length > MAX_BODY_BYTES) return respond(413, { error: 'body_too_large' });

  // 2. Verify.
  let secrets: readonly string[];
  try {
    secrets = await deps.secrets();
  } catch (e) {
    console.error('stripe webhook: signing secret unavailable', { error: reason(e) });
    return respond(500, { error: 'misconfigured' });
  }
  if (!secrets.length) {
    console.error('stripe webhook: no signing secret configured');
    return respond(500, { error: 'misconfigured' });
  }
  if (!verifyStripeSignature(raw, signature, secrets, TOLERANCE_SEC, Math.floor(deps.now().getTime() / 1000))) {
    console.warn('stripe webhook: signature check failed');
    return respond(400, { error: 'invalid_signature' });
  }

  // 3. Parse, now that the bytes are known to be Stripe's.
  let event: StripeEvent;
  try {
    event = parseStripeEvent(raw.toString('utf8'));
  } catch (e) {
    if (!(e instanceof StripePayloadError)) throw e;
    console.warn('stripe webhook: signed payload is not a Stripe event', { error: e.message });
    return respond(400, { error: 'invalid_payload' });
  }
  if (event.livemode !== deps.expectLivemode) {
    console.warn('stripe webhook: event from the wrong Stripe mode', { eventId: event.id, type: event.type });
    return respond(400, { error: 'wrong_mode' });
  }

  // 4. Types we do not act on.
  if (!isHandledEventType(event.type)) return respond(200, { received: true, outcome: 'ignored:type' });

  // 5. Claim the event id.
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  let claim: ClaimResult;
  try {
    claim = await deps.store.claimEvent(event.id, event.type, nowSec);
  } catch (e) {
    console.error('stripe webhook: could not claim event', { eventId: event.id, type: event.type, error: reason(e) });
    return respond(500, { error: 'processing_failed' });
  }
  if (claim === 'done') return respond(200, { received: true, outcome: 'duplicate' });
  if (claim === 'in_progress') return respond(409, { error: 'in_progress' });

  // 6 to 8. Work, then mark done. Any failure frees the claim and lets Stripe retry.
  try {
    const outcome = await processEvent(event, req.requestContext?.requestId, deps);
    await deps.store.completeEvent(event.id, outcome, nowSec);
    console.info('stripe webhook', { eventId: event.id, type: event.type, outcome });
    return respond(200, { received: true, outcome });
  } catch (e) {
    console.error('stripe webhook: processing failed', { eventId: event.id, type: event.type, error: reason(e) });
    await deps.store.releaseEvent(event.id).catch(() => undefined);
    return respond(500, { error: 'processing_failed' });
  }
}

/** Returns the outcome recorded on the ledger. Throws to make Stripe retry. */
async function processEvent(event: StripeEvent, requestId: string | undefined, deps: WebhookDeps): Promise<string> {
  const customerId = customerIdOf(event);
  if (!customerId) return 'ignored:no_customer';

  // Our own record decides which tenant this is. Event metadata is never consulted.
  const mapped = await deps.store.tenantForCustomer(customerId);
  if (!mapped) {
    console.warn('stripe webhook: customer is not one of ours', { eventId: event.id, type: event.type });
    return 'ignored:unknown_customer';
  }
  const tenantId = asTenantId(mapped); // a corrupt route record is a bug to surface, so this throws
  const profile = await deps.store.getProfile(tenantId);
  if (!profile) {
    console.error('stripe webhook: customer route points at a missing tenant', { eventId: event.id });
    return 'ignored:unknown_customer';
  }

  // Stripe does not promise order. An event older than what we already applied must not undo it.
  const lastAt = typeof profile.billingEventAt === 'number' ? profile.billingEventAt : 0;
  if (event.created < lastAt) return 'ignored:stale';

  const previous = str(profile.state) ?? 'active';
  const plan = planBilling(event, { state: str(profile.state), stateReasonCode: str(profile.stateReasonCode) });
  const at = () => deps.now().toISOString();
  const withRequest = requestId ? { requestId } : {};

  // Audit first: if this cannot be recorded, nothing below happens.
  await deps.audit({
    tenantId,
    action: `billing:${event.type}`,
    reasonCode: BILLING_REASON,
    actor: BILLING_ACTOR,
    at: at(),
    ...withRequest,
    detail: {
      stripeEventId: event.id,
      stripeEventCreated: event.created,
      ...(plan.billingStatus ? { billingStatus: plan.billingStatus } : {}),
      ...(typeof profile.billingStatus === 'string' ? { previousBillingStatus: profile.billingStatus } : {}),
      stateChange: plan.stateTarget ?? 'none',
      ...(plan.kept ? { kept: plan.kept } : {}),
      ...(plan.notify ? { ownerNotice: plan.notify } : {}),
      ...billingFacts(event),
    },
  });

  const recorded = await deps.store.recordBilling(tenantId, {
    ...(plan.billingStatus ? { status: plan.billingStatus } : {}),
    eventId: event.id,
    eventAt: event.created,
  });
  if (recorded === 'stale') return 'ignored:stale'; // a newer event won the race while we were working

  let outcome = plan.kept ? `kept:${plan.kept}` : 'recorded';
  if (plan.stateTarget) {
    const ref = engineRefFromProfile(tenantId, profile);
    if (!ref) throw new Error('engine_not_provisioned'); // a suspension that cannot reach the engine must not look done
    await setTenantState(tenantId, plan.stateTarget, BILLING_REASON, BILLING_ACTOR, {
      engineFor: (r) => deps.engineFor(r),
      loadRef: async () => ref,
      writeState: (t, s, why, who) => deps.store.writeState(t, s, { reasonCode: why, actor: who, at: at() }),
      audit: (e) => deps.audit({ ...e, ...withRequest }),
      now: deps.now,
    }, { detail: { stripeEventId: event.id } });
    outcome = `state:${plan.stateTarget}`;
    try {
      await deps.emit(makeEvent(
        'tenant.state_changed',
        { tenantId, correlationId: event.id },
        { state: plan.stateTarget, previousState: previous, reasonCode: BILLING_REASON, actor: BILLING_ACTOR },
        deps.now(),
      ));
    } catch (e) {
      // The change is made and audited; a missed announcement must not make Stripe replay it.
      console.error('stripe webhook: state event not published', { eventId: event.id, error: reason(e) });
    }
  }

  if (plan.notify && deps.notifyOwner) {
    try { await deps.notifyOwner(tenantId, plan.notify, event.id); } catch (e) {
      console.error('stripe webhook: owner notice not sent', { eventId: event.id, error: reason(e) });
    }
  }
  return outcome;
}

// ───────────────────────── DynamoDB ─────────────────────────
/** A claim that nothing finished within this long is up for grabs again (the Lambda timeout is far shorter). */
const LEASE_SEC = 60;
/** Stripe retries for 3 days and keeps events 30 days; keep the ledger a little longer than that. */
const LEDGER_TTL_SEC = 35 * 24 * 3600;
const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,100}$/;

const isConditionalFailure = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

export interface DdbBillingStoreConfig {
  ddb: Pick<DynamoDBDocumentClient, 'send'>;
  table: string;
  /** Profile reads and state writes go through the same code the admin console uses, so both agree on attribute names. */
  getProfile(tenantId: string): Promise<TenantProfile | undefined>;
  writeState(tenantId: string, state: TenantRuntimeState, meta: { reasonCode: string; actor: string; at: string }): Promise<void>;
}

/**
 * Items (see contracts/CHANGE_REQUESTS/H1-2.md):
 *  - STRIPEEVT#<eventId> / SEEN: ledger row, status processing|done, TTL.
 *  - STRIPECUST#<customerId> / ROUTE: `tid`, written when the tenant is activated. Read only here.
 *  - TENANT#<tid> / PROFILE: billingStatus, billingEventAt, billingEventId.
 */
export class DdbBillingStore implements BillingStore {
  constructor(private cfg: DdbBillingStoreConfig) {}

  private eventKey(eventId: string) {
    if (!EVENT_ID_RE.test(eventId)) throw new Error('invalid stripe event id');
    return { PK: `STRIPEEVT#${eventId}`, SK: 'SEEN' };
  }

  async claimEvent(eventId: string, type: string, nowSec: number): Promise<ClaimResult> {
    const key = this.eventKey(eventId);
    try {
      await this.cfg.ddb.send(new PutCommand({
        TableName: this.cfg.table,
        Item: { ...key, status: 'processing', type, claimedAt: nowSec, leaseUntil: nowSec + LEASE_SEC, ttl: nowSec + LEDGER_TTL_SEC },
        ConditionExpression: 'attribute_not_exists(PK) OR (#st = :processing AND leaseUntil < :now)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':processing': 'processing', ':now': nowSec },
      }));
      return 'claimed';
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
    const cur = await this.cfg.ddb.send(new GetCommand({ TableName: this.cfg.table, Key: key, ConsistentRead: true }));
    return cur.Item?.status === 'done' ? 'done' : 'in_progress';
  }

  async completeEvent(eventId: string, outcome: string, nowSec: number): Promise<void> {
    try {
      await this.cfg.ddb.send(new UpdateCommand({
        TableName: this.cfg.table,
        Key: this.eventKey(eventId),
        UpdateExpression: 'SET #st = :done, outcome = :o, doneAt = :t, #ttl = :ttl REMOVE leaseUntil',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#st': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':done': 'done', ':o': outcome, ':t': nowSec, ':ttl': nowSec + LEDGER_TTL_SEC },
      }));
    } catch (e) {
      if (!isConditionalFailure(e)) throw e; // the row is gone (TTL): nothing to finish
    }
  }

  async releaseEvent(eventId: string): Promise<void> {
    try {
      await this.cfg.ddb.send(new DeleteCommand({
        TableName: this.cfg.table,
        Key: this.eventKey(eventId),
        ConditionExpression: '#st = :processing',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':processing': 'processing' },
      }));
    } catch (e) {
      if (!isConditionalFailure(e)) throw e; // already done or already gone
    }
  }

  async tenantForCustomer(customerId: string): Promise<string | undefined> {
    if (!isStripeCustomerId(customerId)) throw new Error('invalid stripe customer id');
    const r = await this.cfg.ddb.send(new GetCommand({
      TableName: this.cfg.table,
      Key: { PK: `STRIPECUST#${customerId}`, SK: keys.routeSk() },
      ConsistentRead: true,
    }));
    const tid = r.Item?.tid ?? r.Item?.tenantId;
    return typeof tid === 'string' ? tid : undefined;
  }

  getProfile(tenantId: string) { return this.cfg.getProfile(tenantId); }
  writeState(tenantId: string, state: TenantRuntimeState, meta: { reasonCode: string; actor: string; at: string }) {
    return this.cfg.writeState(tenantId, state, meta);
  }

  async recordBilling(tenantId: string, rec: { status?: BillingStatus; eventId: string; eventAt: number }): Promise<'recorded' | 'stale'> {
    const sets = ['billingEventAt = :t', 'billingEventId = :e'];
    const values: Record<string, unknown> = { ':t': rec.eventAt, ':e': rec.eventId };
    if (rec.status) { sets.push('billingStatus = :s'); values[':s'] = rec.status; }
    try {
      await this.cfg.ddb.send(new UpdateCommand({
        TableName: this.cfg.table,
        Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
        UpdateExpression: `SET ${sets.join(', ')}`,
        // Forward in time only. A missing profile fails the same condition; the caller read it a moment ago.
        ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(billingEventAt) OR billingEventAt <= :t)',
        ExpressionAttributeValues: values,
      }));
      return 'recorded';
    } catch (e) {
      if (isConditionalFailure(e)) return 'stale';
      throw e;
    }
  }
}

// ───────────────────────── wiring ─────────────────────────
const SECRET_TTL_MS = 60_000;

/**
 * The endpoint signing secret lives in the runtime secret (`1145/<stage>/runtime`, key STRIPE_WEBHOOK_SECRET, pushed
 * by scripts/secrets/push.sh). During a rotation put both values in that key separated by a comma: `new,old`.
 * Cached for a minute so a rotation is picked up quickly.
 */
export function stripeSecrets(sm: Pick<SecretsManagerClient, 'send'>, secretId: string, clock: () => number = Date.now): () => Promise<string[]> {
  let cache: { value: string[]; at: number } | undefined;
  return async () => {
    if (cache && clock() - cache.at < SECRET_TTL_MS) return cache.value;
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    let parsed: unknown;
    try { parsed = JSON.parse(r.SecretString ?? ''); } catch { throw new Error('runtime secret is not JSON'); }
    const raw = (parsed as Record<string, unknown> | null)?.STRIPE_WEBHOOK_SECRET;
    const value = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!value.length) throw new Error('STRIPE_WEBHOOK_SECRET missing from the runtime secret');
    cache = { value, at: clock() };
    return value;
  };
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** `STRIPE_LIVEMODE` is `true` only on a deployment that takes real money. Unset means test mode. */
function livemodeFrom(env: NodeJS.ProcessEnv): boolean {
  const v = env.STRIPE_LIVEMODE;
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  throw new Error('STRIPE_LIVEMODE must be "true" or "false"');
}

export function createWebhookDeps(env: NodeJS.ProcessEnv = process.env): WebhookDeps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({});
  const eb = new EventBridgeClient({});
  const table = need(env, 'TABLE_NAME');
  const consoleStore = new DdbConsoleStore({ ddb, s3, table, tenantBucket: need(env, 'TENANT_BUCKET') });
  const bus = need(env, 'EVENT_BUS_NAME');
  return {
    secrets: stripeSecrets(new SecretsManagerClient({}), need(env, 'RUNTIME_SECRET_ID')),
    expectLivemode: livemodeFrom(env),
    store: new DdbBillingStore({
      ddb,
      table,
      getProfile: (t) => consoleStore.getProfile(t),
      writeState: (t, s, m) => consoleStore.writeState(t, s, m),
    }),
    engineFor: consoleEngineFor({ ddb, table, store: consoleStore }),
    audit: auditWriter(s3, need(env, 'AUDIT_BUCKET'), { source: 'stripe-webhook' }),
    emit: async (event) => {
      const r = await eb.send(new PutEventsCommand({
        Entries: [{ EventBusName: bus, Source: '1145.control-plane', DetailType: event.type, Detail: JSON.stringify(event) }],
      }));
      if (r.FailedEntryCount) throw new Error('event bus rejected the event');
    },
    now: () => new Date(),
  };
}

let cached: WebhookDeps | undefined;

export async function handler(event: WebhookRequest): Promise<WebhookResponse> {
  cached ??= createWebhookDeps();
  return handleStripeWebhook(event, cached);
}
