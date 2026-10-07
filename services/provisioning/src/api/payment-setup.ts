/**
 * Card on file before a number is bought (abuse control). Owner: issue D9 (tasks/D9.md).
 * Contract: POST /internal/onboarding/{onboardingId}/payment-setup in contracts/openapi/onboarding-internal.yaml.
 *
 * How it works
 *  - Each onboarding gets exactly one Stripe customer (`ONBOARDING#<id>` / `PAYMENT` remembers it, first writer wins).
 *  - The card is typed into a Stripe-hosted page (Checkout in setup mode, which makes a SetupIntent underneath).
 *    Our code never sees a card number: it only asks Stripe which cards are attached to the customer.
 *  - This endpoint returns that hosted link plus a friendly line for the router to send in the owner's channel. The
 *    agent never sees either. `steps/check-payment-method.ts` is the gate in the workflow and shares everything below.
 *
 * Identity: the onboarding id comes from the path (bound by the router from the verified channel identity) and the
 * caller must hold the onboarding service token. The request body is never read, so neither the model nor the caller
 * can point this at another onboarding or another Stripe customer.
 *
 * Stripe runs in test mode only: a live key is refused unless STRIPE_ALLOW_LIVE=true is set on purpose.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';

/* ------------------------------------------------------------------ ports */

export interface CardOnFile {
  paymentMethodId: string;
  /** Same physical card, same fingerprint, across customers. Lets abuse controls (trial caps) spot a reused card. */
  fingerprint?: string;
  /** credit | debit | prepaid | unknown */
  funding?: string;
  expMonth: number;
  expYear: number;
}

export interface SetupSession { sessionId: string; url: string; expiresAt: Date }

export interface PaymentGateway {
  /** Same onboarding id, same customer: safe to repeat after a crash. */
  createCustomer(onboardingId: string): Promise<{ customerId: string }>;
  /** A Stripe-hosted page where the owner saves a card for this customer. Nothing is charged. */
  createSetupSession(input: { customerId: string; onboardingId: string }): Promise<SetupSession>;
  /** Cards attached to the customer (that is, saved through a completed setup). */
  listCards(customerId: string): Promise<CardOnFile[]>;
}

export interface PaymentRecord {
  customerId: string;
  /** ISO time the owner was last asked for a card (by the router or the workflow). */
  promptedAt?: string;
}

export interface PaymentStore {
  get(onboardingId: string): Promise<PaymentRecord | undefined>;
  /** First writer wins; returns the record of record, which may be someone else's. */
  putCustomer(onboardingId: string, customerId: string): Promise<PaymentRecord>;
  markPrompted(onboardingId: string, at: Date): Promise<void>;
}

/** Stripe is unreachable, throttled or failing (5xx). Nothing was lost; the caller or the workflow may retry. */
export class PaymentUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentUnavailable'; }
}

/* ------------------------------------------------------------------ rules */

const ONBOARDING_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
export const isValidOnboardingId = (v: unknown): v is string => typeof v === 'string' && ONBOARDING_ID_RE.test(v);

/** A card is good through the last day of the month on it. */
export function isUsableCard(card: CardOnFile, now: Date): boolean {
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return card.expYear * 12 + (card.expMonth - 1) >= thisMonth;
}
export const firstUsableCard = (cards: readonly CardOnFile[], now: Date): CardOnFile | undefined => cards.find((c) => isUsableCard(c, now));

/** What the owner reads in chat. The `messageForOwner:` literals are also what CI's conversation-style check scans. */
export const ownerCopy = {
  askForCard: (url: string) => ({
    messageForOwner: `Before I pick your number, I need a card on file. It just keeps fake sign-ups out, and nothing gets charged. You can add it here: ${url}`,
  }),
  remindAboutCard: (url: string) => ({
    messageForOwner: `Whenever you're ready, I still need a card on file before I can get your number. Here's a fresh link: ${url}`,
  }),
  cardReceived: () => ({ messageForOwner: 'Got your card, thanks! Finding your number now.' }),
};

/** One customer per onboarding, however many times this runs. */
export async function ensureCustomer(onboardingId: string, deps: { gateway: Pick<PaymentGateway, 'createCustomer'>; store: PaymentStore }): Promise<PaymentRecord> {
  const existing = await deps.store.get(onboardingId);
  if (existing) return existing;
  const { customerId } = await deps.gateway.createCustomer(onboardingId);
  return deps.store.putCustomer(onboardingId, customerId);
}

export type CardLink = { status: 'card_on_file' } | { status: 'link_ready'; url: string; expiresAt: string };

/** Card already saved: say so. Otherwise a fresh hosted link, and note that the owner has now been asked. */
export async function requestCardLink(onboardingId: string, deps: { gateway: PaymentGateway; store: PaymentStore; now: () => Date }): Promise<CardLink> {
  const customer = await ensureCustomer(onboardingId, deps);
  if (firstUsableCard(await deps.gateway.listCards(customer.customerId), deps.now())) return { status: 'card_on_file' };
  const session = await deps.gateway.createSetupSession({ customerId: customer.customerId, onboardingId });
  await deps.store.markPrompted(onboardingId, deps.now()); // the workflow step then waits instead of sending a second message
  return { status: 'link_ready', url: session.url, expiresAt: session.expiresAt.toISOString() };
}

/* ------------------------------------------------------------------ Stripe */

/** Only the three Stripe calls this lane needs, so nothing here can take or confirm card details. */
export interface StripeLike {
  customers: { create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }> };
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string; url: string | null; expires_at: number }> } };
  paymentMethods: {
    list(params: Stripe.PaymentMethodListParams, options?: Stripe.RequestOptions): Promise<{
      data: Array<{ id: string; type: string; card?: { fingerprint?: string | null; funding?: string | null; exp_month: number; exp_year: number } | null }>;
    }>;
  };
}

const TRANSIENT_STRIPE_ERRORS = new Set(['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']);

async function viaStripe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const type = (err as { type?: unknown })?.type;
    if (typeof type === 'string' && TRANSIENT_STRIPE_ERRORS.has(type)) throw new PaymentUnavailableError(`stripe ${what} unavailable (${type})`); // no key, no body
    throw err;
  }
}

export function stripeGateway(stripe: StripeLike, urls: { successUrl: string; cancelUrl: string }): PaymentGateway {
  return {
    async createCustomer(onboardingId) {
      // Only our own id goes to Stripe: no name, email or phone of the owner. The idempotency key makes a retry after a
      // crash return the same customer instead of a second one.
      const c = await viaStripe('customers.create', () => stripe.customers.create({ metadata: { onboardingId } }, { idempotencyKey: `1145-customer-${onboardingId}` }));
      return { customerId: c.id };
    },

    async createSetupSession({ customerId, onboardingId }) {
      const s = await viaStripe('checkout.sessions.create', () => stripe.checkout.sessions.create({
        mode: 'setup', // saves a card through a SetupIntent; no PaymentIntent, nothing is charged
        customer: customerId,
        payment_method_types: ['card'],
        success_url: urls.successUrl,
        cancel_url: urls.cancelUrl,
        client_reference_id: onboardingId,
        metadata: { onboardingId },
        setup_intent_data: { metadata: { onboardingId } },
      }));
      if (!s.url) throw new Error('stripe checkout session came back without a url');
      return { sessionId: s.id, url: s.url, expiresAt: new Date(s.expires_at * 1000) };
    },

    async listCards(customerId) {
      const r = await viaStripe('paymentMethods.list', () => stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 10 }));
      return r.data.flatMap((pm) => {
        if (pm.type !== 'card' || !pm.card) return [];
        return [{
          paymentMethodId: pm.id,
          ...(pm.card.fingerprint ? { fingerprint: pm.card.fingerprint } : {}),
          ...(pm.card.funding ? { funding: pm.card.funding } : {}),
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        }];
      });
    },
  };
}

/** Test-mode only unless live was switched on on purpose. Never echoes the value it rejects. */
export function assertTestModeKey(key: string, allowLive: boolean): void {
  const m = /^(?:sk|rk)_(test|live)_\S+$/.exec(key);
  if (!m) throw new Error('STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_test_… or rk_test_…)');
  if (m[1] === 'live' && !allowLive) throw new Error('Stripe live keys are refused: this build is test mode only (set STRIPE_ALLOW_LIVE=true to go live on purpose)');
}

export interface StripeConfig { secretKey: string; successUrl: string; cancelUrl: string }
const DEFAULT_RETURN_URL = 'https://1145.ai';

/** Stripe key lives in one Secrets Manager JSON secret: { STRIPE_SECRET_KEY }. URLs are plain env. */
export async function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): Promise<StripeConfig> {
  const arn = env.STRIPE_SECRET_ARN;
  if (!arn) throw new Error('STRIPE_SECRET_ARN is not set');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString ?? '{}') as Record<string, string | undefined>;
  const secretKey = parsed.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe secret is missing STRIPE_SECRET_KEY');
  assertTestModeKey(secretKey, env.STRIPE_ALLOW_LIVE === 'true');
  return { secretKey, successUrl: env.PAYMENT_SUCCESS_URL || DEFAULT_RETURN_URL, cancelUrl: env.PAYMENT_CANCEL_URL || DEFAULT_RETURN_URL };
}

/* ------------------------------------------------------------------ DynamoDB */

/**
 * `ONBOARDING#<id>` / `PAYMENT`: the Stripe customer for this onboarding. Lives next to the router's `STATE` item
 * because the tenant does not exist yet when the card is first requested (see CR D9-1).
 */
export function ddbPaymentStore(client: { send(cmd: any): Promise<any> }, table: string, now: () => Date = () => new Date()): PaymentStore {
  const key = (onboardingId: string) => {
    if (!isValidOnboardingId(onboardingId)) throw new Error('invalid onboarding id');
    return { PK: `ONBOARDING#${onboardingId}`, SK: 'PAYMENT' };
  };
  const read = async (onboardingId: string): Promise<PaymentRecord | undefined> => {
    const r = await client.send(new GetCommand({ TableName: table, Key: key(onboardingId), ConsistentRead: true }));
    const item = r.Item as { customerId?: string; promptedAt?: string } | undefined;
    return item?.customerId ? { customerId: item.customerId, ...(item.promptedAt ? { promptedAt: item.promptedAt } : {}) } : undefined;
  };
  return {
    get: read,

    async putCustomer(onboardingId, customerId) {
      try {
        await client.send(new PutCommand({
          TableName: table, Item: { ...key(onboardingId), customerId, createdAt: now().toISOString() },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        return { customerId };
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        const winner = await read(onboardingId);
        if (!winner) throw err;
        return winner;
      }
    },

    async markPrompted(onboardingId, at) {
      await client.send(new UpdateCommand({
        TableName: table, Key: key(onboardingId),
        UpdateExpression: 'SET promptedAt = :at', ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': at.toISOString() },
      }));
    },
  };
}

/** Wiring shared by the API Lambda and the workflow step: Stripe from the secret, state in the single table. */
export async function productionPayments(): Promise<{ gateway: PaymentGateway; store: PaymentStore; doc: DynamoDBDocumentClient; table: string }> {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const cfg = await loadStripeConfig();
  const stripe = new Stripe(cfg.secretKey, { maxNetworkRetries: 2, timeout: 10_000, appInfo: { name: '1145ai-provisioning' } });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return { gateway: stripeGateway(stripe, cfg), store: ddbPaymentStore(doc, table), doc, table };
}

/* ------------------------------------------------------------------ HTTP */

export interface PaymentSetupDeps {
  /** Current first, then the previous one while a key is being rotated. */
  serviceTokens(): readonly string[];
  onboardingExists(onboardingId: string): Promise<boolean>;
  gateway: PaymentGateway;
  store: PaymentStore;
  now?: () => Date;
}

interface ApiEvent {
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  httpMethod?: string;
}
interface ApiResult { statusCode: number; headers: Record<string, string>; body: string }

const json = (statusCode: number, body: unknown): ApiResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const digest = (s: string) => createHash('sha256').update(s).digest();

function bearer(headers: ApiEvent['headers']): string | undefined {
  const name = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === 'authorization');
  return /^Bearer\s+(\S+)$/i.exec((name && headers?.[name]) || '')?.[1];
}

/** Constant-time against every configured token; an unset (empty) token never matches anything. */
function authorized(headers: ApiEvent['headers'], tokens: readonly string[]): boolean {
  const given = bearer(headers);
  if (!given) return false;
  const g = digest(given);
  let ok = false;
  for (const t of tokens) if (t && timingSafeEqual(digest(t), g)) ok = true;
  return ok;
}

/** The path is the only source of the id: HTTP API path parameter, else the raw path. */
function onboardingIdFrom(ev: ApiEvent): string | undefined {
  const p = ev.pathParameters;
  return p?.onboardingId ?? p?.id ?? /^\/internal\/onboarding\/([^/]*)\/payment-setup\/?$/.exec(ev.rawPath ?? '')?.[1];
}

export function makeHandler(deps: PaymentSetupDeps) {
  const now = deps.now ?? (() => new Date());
  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    if (!authorized(ev.headers, deps.serviceTokens())) return json(401, { error: 'unauthorized' });
    if ((ev.requestContext?.http?.method ?? ev.httpMethod) !== 'POST') return json(405, { error: 'method_not_allowed' });

    const onboardingId = onboardingIdFrom(ev); // the body is deliberately never read
    if (!isValidOnboardingId(onboardingId)) return json(400, { error: 'invalid_onboarding_id' });

    try {
      if (!(await deps.onboardingExists(onboardingId))) return json(404, { error: 'unknown_onboarding' }); // no Stripe customers for made-up ids
      const r = await requestCardLink(onboardingId, { gateway: deps.gateway, store: deps.store, now });
      return json(200, r.status === 'link_ready' ? { ...r, ...ownerCopy.askForCard(r.url) } : r);
    } catch (err) {
      if (err instanceof PaymentUnavailableError) return json(503, { error: 'unavailable' });
      console.error(JSON.stringify({ level: 'error', handler: 'payment-setup', onboardingId, error: (err as Error)?.name ?? 'unknown' })); // never the message: it can carry Stripe ids
      return json(500, { error: 'internal' });
    }
  };
}

let memo: Promise<ReturnType<typeof makeHandler>> | undefined;

/** Lambda entry. Clients are built on first use so importing this file (the workflow step does) has no side effects. */
export async function handler(event: unknown): Promise<ApiResult> {
  memo ??= productionPayments().then(({ gateway, store, doc, table }) => makeHandler({
    serviceTokens: () => [process.env.ONBOARDING_SERVICE_TOKEN, process.env.ONBOARDING_SERVICE_TOKEN_PREVIOUS].filter((t): t is string => !!t),
    onboardingExists: async (id) => !!(await doc.send(new GetCommand({ TableName: table, Key: { PK: `ONBOARDING#${id}`, SK: 'STATE' }, ProjectionExpression: 'PK' }))).Item,
    gateway, store,
  }));
  memo.catch(() => { memo = undefined; }); // a bad config or a cold-start blip must not stick for the life of the container
  try {
    return await (await memo)(event);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', handler: 'payment-setup', stage: 'init', error: (err as Error)?.name ?? 'unknown' }));
    return json(500, { error: 'internal' });
  }
}
