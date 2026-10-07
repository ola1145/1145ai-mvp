import { readFileSync } from 'node:fs';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { describe, expect, it } from 'vitest';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import {
  assertTestModeKey, ddbPaymentStore, ensureCustomer, makeHandler, ownerCopy, PaymentUnavailableError, stripeGateway,
  type CardOnFile, type PaymentGateway, type PaymentRecord, type PaymentStore, type StripeLike,
} from '../src/api/payment-setup.js';
import { checkPaymentMethod, ebStatusEmitter, NeedsPaymentMethodError, type OnboardingStatus } from '../src/steps/check-payment-method.js';
import { orderNumber, type OrderState } from '../src/steps/order-number.js';

/**
 * Everything here is a hand-written fake. No Stripe, DynamoDB or EventBridge call is made, no card is ever
 * collected by our code (the owner types it into Stripe's hosted page) and no number is bought.
 */
const ONB = 'o_0123456789abcdef0123';
const TENANT = 't_abcdefgh1';
const NOW = new Date('2026-10-06T12:00:00Z');
const URL_RE = /https:\/\/checkout\.stripe\.test\/c\/setup\/cs_test_\d+/;

class FakeGateway implements PaymentGateway {
  customersByOnboarding = new Map<string, string>();
  customerCreates = 0;
  sessions: Array<{ customerId: string; onboardingId: string; url: string }> = [];
  cards = new Map<string, CardOnFile[]>();
  idempotent = true;                       // Stripe returns the same customer for the same idempotency key
  down: Error | undefined;
  listCalls = 0;

  async createCustomer(onboardingId: string) {
    if (this.down) throw this.down;
    const existing = this.idempotent ? this.customersByOnboarding.get(onboardingId) : undefined;
    if (existing) return { customerId: existing };
    const customerId = `cus_${++this.customerCreates}`;
    this.customersByOnboarding.set(onboardingId, customerId);
    return { customerId };
  }
  async createSetupSession(input: { customerId: string; onboardingId: string }) {
    if (this.down) throw this.down;
    const n = this.sessions.length + 1;
    const url = `https://checkout.stripe.test/c/setup/cs_test_${n}`;
    this.sessions.push({ ...input, url });
    return { sessionId: `cs_test_${n}`, url, expiresAt: new Date(NOW.getTime() + 24 * 3600_000) };
  }
  async listCards(customerId: string) {
    this.listCalls++;
    if (this.down) throw this.down;
    return this.cards.get(customerId) ?? [];
  }
  /** What the owner does on Stripe's hosted page: the card gets attached to their customer. */
  attachCard(customerId: string, over: Partial<CardOnFile> = {}) {
    const card: CardOnFile = { paymentMethodId: 'pm_1', fingerprint: 'fpAAAA1111bbbb', funding: 'credit', expMonth: 12, expYear: 2030, ...over };
    this.cards.set(customerId, [...(this.cards.get(customerId) ?? []), card]);
    return card;
  }
}

function memoryStore(): PaymentStore & { rows: Map<string, PaymentRecord> } {
  const rows = new Map<string, PaymentRecord>();
  return {
    rows,
    get: async (id) => rows.get(id),
    putCustomer: async (id, customerId) => { if (!rows.has(id)) rows.set(id, { customerId }); return rows.get(id)!; },
    markPrompted: async (id, at) => { rows.set(id, { ...rows.get(id)!, promptedAt: at.toISOString() }); },
  };
}

const styleIssues = (text: string) => checkReply(text, { channel: 'chat' });

/* ------------------------------------------------------------------ the customer that owns the card */

describe('ensureCustomer: one Stripe customer per onboarding', () => {
  it('creates the customer once and remembers it', async () => {
    const gateway = new FakeGateway(); const store = memoryStore();
    const a = await ensureCustomer(ONB, { gateway, store });
    const b = await ensureCustomer(ONB, { gateway, store });
    expect(a.customerId).toBe('cus_1');
    expect(b).toEqual(a);
    expect(gateway.customerCreates).toBe(1);
    expect(store.rows.get(ONB)?.customerId).toBe('cus_1');
  });

  it('two racing first calls end up on the same customer (first write wins, even if Stripe handed out two)', async () => {
    const gateway = new FakeGateway(); gateway.idempotent = false; const store = memoryStore();
    const [a, b] = await Promise.all([ensureCustomer(ONB, { gateway, store }), ensureCustomer(ONB, { gateway, store })]);
    expect(a.customerId).toBe(b.customerId);
    expect(store.rows.size).toBe(1);
  });

  it('different onboardings never share a customer', async () => {
    const gateway = new FakeGateway(); const store = memoryStore();
    const a = await ensureCustomer(ONB, { gateway, store });
    const b = await ensureCustomer('o_ffffffffffffffffffff', { gateway, store });
    expect(a.customerId).not.toBe(b.customerId);
  });
});

/* ------------------------------------------------------------------ Stripe adapter */

type Call = { method: string; params: any; options?: any };
function fakeStripe(over: { sessionUrl?: string | null; pms?: any[]; fail?: unknown } = {}) {
  const calls: Call[] = [];
  const maybeFail = () => { if (over.fail) throw over.fail; };
  const stripe: StripeLike = {
    customers: { create: async (params, options) => { calls.push({ method: 'customers.create', params, options }); maybeFail(); return { id: 'cus_live1' }; } },
    checkout: { sessions: { create: async (params, options) => {
      calls.push({ method: 'checkout.sessions.create', params, options }); maybeFail();
      const url = over.sessionUrl === undefined ? 'https://checkout.stripe.test/c/setup/cs_test_9' : over.sessionUrl;
      return { id: 'cs_test_9', url, expires_at: Math.floor(NOW.getTime() / 1000) + 86_400 };
    } } },
    paymentMethods: { list: async (params, options) => { calls.push({ method: 'paymentMethods.list', params, options }); maybeFail(); return { data: over.pms ?? [] }; } },
  };
  return { stripe, calls };
}
const cfg = { successUrl: 'https://1145.ai/card/added', cancelUrl: 'https://1145.ai/card/cancelled' };

describe('stripeGateway (fake Stripe client)', () => {
  it('creates the customer with an idempotency key and only the onboarding id as metadata', async () => {
    const { stripe, calls } = fakeStripe();
    const out = await stripeGateway(stripe, cfg).createCustomer(ONB);
    expect(out).toEqual({ customerId: 'cus_live1' });
    const c = calls[0]!;
    expect(c.params).toEqual({ metadata: { onboardingId: ONB } });   // no name, email or phone of the owner
    expect(c.options?.idempotencyKey).toContain(ONB);
  });

  it('the card is collected on a Stripe-hosted page: setup-mode Checkout for this customer, cards only, nothing charged', async () => {
    const { stripe, calls } = fakeStripe();
    const s = await stripeGateway(stripe, cfg, () => NOW).createSetupSession({ customerId: 'cus_9', onboardingId: ONB });
    expect(s).toEqual({ sessionId: 'cs_test_9', url: 'https://checkout.stripe.test/c/setup/cs_test_9', expiresAt: new Date('2026-10-07T12:00:00Z') });
    const p = calls[0]!.params;
    expect(p.mode).toBe('setup');                                    // creates a SetupIntent underneath; no PaymentIntent, no charge
    expect(p.customer).toBe('cus_9');
    expect(p.payment_method_types).toEqual(['card']);
    expect(p.success_url).toBe(cfg.successUrl);
    expect(p.cancel_url).toBe(cfg.cancelUrl);
    expect(p.client_reference_id).toBe(ONB);
    expect(p.setup_intent_data.metadata).toEqual({ onboardingId: ONB });
    expect(JSON.stringify(p)).not.toMatch(/amount|line_items|card\[/);
  });

  it('a session without a url is an error, never an empty link', async () => {
    const { stripe } = fakeStripe({ sessionUrl: null });
    await expect(stripeGateway(stripe, cfg).createSetupSession({ customerId: 'cus_9', onboardingId: ONB })).rejects.toThrow(/url/);
  });

  it('lists only cards attached to the customer and maps the fields we use', async () => {
    const { stripe, calls } = fakeStripe({ pms: [
      { id: 'pm_a', type: 'card', card: { fingerprint: 'fpZZ', funding: 'prepaid', exp_month: 1, exp_year: 2031, last4: '4242', brand: 'visa' } },
      { id: 'pm_b', type: 'card', card: { fingerprint: null, funding: 'debit', exp_month: 5, exp_year: 2029 } },
      { id: 'pm_c', type: 'us_bank_account' },
    ] });
    const cards = await stripeGateway(stripe, cfg).listCards('cus_9');
    expect(calls[0]!.params).toMatchObject({ customer: 'cus_9', type: 'card' });
    expect(cards).toEqual([
      { paymentMethodId: 'pm_a', fingerprint: 'fpZZ', funding: 'prepaid', expMonth: 1, expYear: 2031 },
      { paymentMethodId: 'pm_b', funding: 'debit', expMonth: 5, expYear: 2029 },
    ]);
    expect(JSON.stringify(cards)).not.toContain('4242');           // last4 and brand are not carried around
  });

  it('connection, rate limit and server errors become PaymentUnavailable (retryable); others pass through', async () => {
    for (const type of ['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']) {
      const { stripe } = fakeStripe({ fail: Object.assign(new Error('boom sk_test_SECRET'), { type }) });
      const err = await stripeGateway(stripe, cfg).listCards('cus_9').catch((e: Error) => e);
      expect(err).toBeInstanceOf(PaymentUnavailableError);
      expect((err as Error).name).toBe('PaymentUnavailable');
      expect((err as Error).message).not.toContain('sk_test_SECRET');
    }
    const bad = Object.assign(new Error('No such customer'), { type: 'StripeInvalidRequestError' });
    const { stripe } = fakeStripe({ fail: bad });
    expect(await stripeGateway(stripe, cfg).listCards('cus_9').catch((e: Error) => e)).toBe(bad);
  });
});

describe('Stripe key guard', () => {
  it('accepts test-mode keys', () => {
    expect(() => assertTestModeKey('sk_test_x', false)).not.toThrow();
    expect(() => assertTestModeKey('rk_test_x', false)).not.toThrow();
  });
  it('refuses a live key unless live mode was switched on on purpose', () => {
    expect(() => assertTestModeKey('sk_live_x', false)).toThrow(/test/i);
    expect(() => assertTestModeKey('rk_live_x', false)).toThrow(/test/i);
    expect(() => assertTestModeKey('sk_live_x', true)).not.toThrow();
  });
  it('refuses anything that is not a Stripe secret key, without echoing it', () => {
    expect(() => assertTestModeKey('pk_test_publishable', false)).toThrow(/secret key/i);
    const err = (() => { try { assertTestModeKey('whsec_abc123', true); } catch (e) { return e as Error; } })();
    expect(err?.message).not.toContain('abc123');
  });
});

/* ------------------------------------------------------------------ POST /internal/onboarding/{id}/payment-setup */

function apiFixture(over: { tokens?: string[]; onboardings?: string[] } = {}) {
  const gateway = new FakeGateway(); const store = memoryStore();
  const onboardings = new Set(over.onboardings ?? [ONB]);
  const handler = makeHandler({ serviceTokens: () => over.tokens ?? ['svc-token'], onboardingExists: async (id) => onboardings.has(id), gateway, store, now: () => NOW });
  const event = (o: Record<string, unknown> = {}) => ({
    rawPath: `/internal/onboarding/${ONB}/payment-setup`, pathParameters: { id: ONB },
    requestContext: { http: { method: 'POST' } }, headers: { authorization: 'Bearer svc-token' }, body: '{}', ...o,
  });
  return { gateway, store, handler, event };
}
const parse = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;

describe('payment-setup API: auth', () => {
  it('rejects a missing, wrong or malformed bearer token before touching Stripe or the table', async () => {
    const { gateway, store, handler, event } = apiFixture();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'svc-token' }, { authorization: 'Basic svc-token' }, { authorization: 'Bearer ' }]) {
      const r = await handler(event({ headers }));
      expect(r.statusCode).toBe(401);
      expect(parse(r)).toEqual({ error: 'unauthorized' });
    }
    expect(gateway.customerCreates).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('fails closed when no service token is configured, even for an empty bearer', async () => {
    const { handler, event } = apiFixture({ tokens: [] });
    expect((await handler(event())).statusCode).toBe(401);
    expect((await handler(event({ headers: { authorization: 'Bearer ' } }))).statusCode).toBe(401);
    const blank = apiFixture({ tokens: [''] });                        // an unset env var must not become "no password needed"
    expect((await blank.handler(blank.event({ headers: { authorization: 'Bearer ' } }))).statusCode).toBe(401);
    expect((await blank.handler(blank.event({ headers: {} }))).statusCode).toBe(401);
  });

  it('accepts the previous token while the key is being rotated', async () => {
    const { handler, event } = apiFixture({ tokens: ['new-token', 'svc-token'] });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('reads the Authorization header case-insensitively', async () => {
    const { handler, event } = apiFixture();
    expect((await handler(event({ headers: { Authorization: 'Bearer svc-token' } }))).statusCode).toBe(200);
  });
});

describe('payment-setup API: the link', () => {
  it('creates the customer and returns a hosted link plus a friendly line for the router to send', async () => {
    const { gateway, store, handler, event } = apiFixture();
    const r = await handler(event());
    expect(r.statusCode).toBe(200);
    const body = parse(r);
    expect(body.status).toBe('link_ready');
    expect(body.url).toMatch(URL_RE);
    expect(body.expiresAt).toBe('2026-10-07T12:00:00.000Z');
    expect(body.messageForOwner).toContain(body.url);
    expect(styleIssues(body.messageForOwner)).toEqual([]);
    expect(gateway.customerCreates).toBe(1);
    expect(gateway.sessions).toEqual([{ customerId: 'cus_1', onboardingId: ONB, url: body.url }]);
    expect(store.rows.get(ONB)?.customerId).toBe('cus_1');
    expect(r.body).not.toContain('cus_');                              // the Stripe customer id stays server-side
  });

  it('asking again reuses the customer and hands out a fresh link', async () => {
    const { gateway, handler, event } = apiFixture();
    const a = parse(await handler(event())); const b = parse(await handler(event()));
    expect(gateway.customerCreates).toBe(1);
    expect(a.url).not.toBe(b.url);
  });

  it('once a card is attached it says so and does not mint another link', async () => {
    const { gateway, handler, event } = apiFixture();
    await handler(event());
    gateway.attachCard('cus_1');
    const r = await handler(event());
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toEqual({ status: 'card_on_file' });
    expect(gateway.sessions).toHaveLength(1);
  });

  it('an expired card does not count as on file', async () => {
    const { gateway, handler, event } = apiFixture();
    await handler(event());
    gateway.attachCard('cus_1', { expMonth: 9, expYear: 2026 });       // expired at the end of September 2026
    expect(parse(await handler(event())).status).toBe('link_ready');
    gateway.attachCard('cus_1', { paymentMethodId: 'pm_2', expMonth: 10, expYear: 2026 }); // valid through the end of this month
    expect(parse(await handler(event())).status).toBe('card_on_file');
  });
});

describe('payment-setup API: identity and input', () => {
  it('the onboarding id comes from the path only; the body cannot redirect it', async () => {
    const { gateway, store, handler, event } = apiFixture({ onboardings: [ONB, 'o_ffffffffffffffffffff'] });
    const body = JSON.stringify({ onboardingId: 'o_ffffffffffffffffffff', tenantId: 't_victim123', customerId: 'cus_victim', id: 'o_ffffffffffffffffffff' });
    const r = await handler(event({ body }));
    expect(r.statusCode).toBe(200);
    expect(gateway.sessions[0]?.onboardingId).toBe(ONB);
    expect([...store.rows.keys()]).toEqual([ONB]);
  });

  it('works from the raw path when the gateway sends no path parameters', async () => {
    const { handler, event } = apiFixture();
    expect((await handler(event({ pathParameters: undefined }))).statusCode).toBe(200);
  });

  it('an onboarding that does not exist gets a 404 and no Stripe customer', async () => {
    const { gateway, store, handler, event } = apiFixture({ onboardings: [] });
    const r = await handler(event());
    expect(r.statusCode).toBe(404);
    expect(parse(r)).toEqual({ error: 'unknown_onboarding' });
    expect(gateway.customerCreates).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('a malformed id is a 400 and never reaches the table key', async () => {
    const { gateway, handler, event } = apiFixture();
    for (const id of ['o_1#2', 'o 1', '', 'a'.repeat(81), '../x']) {
      const r = await handler(event({ rawPath: `/internal/onboarding/${id}/payment-setup`, pathParameters: { id } }));
      expect(r.statusCode).toBe(400);
    }
    expect(gateway.customerCreates).toBe(0);
  });

  it('only POST is allowed', async () => {
    const { handler, event } = apiFixture();
    expect((await handler(event({ requestContext: { http: { method: 'GET' } } }))).statusCode).toBe(405);
  });
});

describe('payment-setup API: failures', () => {
  it('Stripe being down is a 503 the caller can retry', async () => {
    const { gateway, handler, event } = apiFixture();
    gateway.down = new PaymentUnavailableError('stripe unreachable');
    const r = await handler(event());
    expect(r.statusCode).toBe(503);
    expect(parse(r)).toEqual({ error: 'unavailable' });
  });

  it('anything else is a 500 with no detail', async () => {
    const { gateway, handler, event } = apiFixture();
    gateway.down = new Error('No such customer: cus_secret sk_test_LEAK');
    const r = await handler(event());
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/cus_secret|sk_test_LEAK/);
  });
});

/* ------------------------------------------------------------------ DynamoDB state */

function fakeDoc() {
  const items = new Map<string, Record<string, any>>();
  const sent: unknown[] = [];
  const k = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
  return {
    items, sent,
    async send(cmd: unknown): Promise<any> {
      sent.push(cmd);
      if (cmd instanceof GetCommand) return { Item: items.get(k(cmd.input.Key as any)) };
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as { PK: string; SK: string };
        if (cmd.input.ConditionExpression === 'attribute_not_exists(PK)' && items.has(k(item))) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        items.set(k(item), { ...item }); return {};
      }
      if (cmd instanceof UpdateCommand) {
        const key = k(cmd.input.Key as any);
        const row = items.get(key);
        if (!row) throw Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' });
        row.promptedAt = cmd.input.ExpressionAttributeValues![':at']; return {};
      }
      throw new Error('unexpected command');
    },
  };
}

describe('ddbPaymentStore', () => {
  it('keeps the customer id under ONBOARDING#<id> / PAYMENT, first writer wins', async () => {
    const doc = fakeDoc(); const store = ddbPaymentStore(doc, 't1145', () => NOW);
    expect(await store.get(ONB)).toBeUndefined();
    const first = await store.putCustomer(ONB, 'cus_1');
    const second = await store.putCustomer(ONB, 'cus_2');
    expect(first).toEqual({ customerId: 'cus_1' });
    expect(second).toEqual({ customerId: 'cus_1' });                  // the loser reads the winner's record
    expect(doc.items.get(`ONBOARDING#${ONB}|PAYMENT`)).toMatchObject({ customerId: 'cus_1', createdAt: NOW.toISOString() });
    expect(doc.items.size).toBe(1);
  });

  it('reads strongly consistent, and remembers when the owner was last asked', async () => {
    const doc = fakeDoc(); const store = ddbPaymentStore(doc, 't1145', () => NOW);
    await store.putCustomer(ONB, 'cus_1');
    await store.markPrompted(ONB, NOW);
    expect(await store.get(ONB)).toEqual({ customerId: 'cus_1', promptedAt: NOW.toISOString() });
    const get = doc.sent.find((c) => c instanceof GetCommand) as GetCommand | undefined;
    expect(get?.input.ConsistentRead).toBe(true);
  });

  it('rejects an id that could escape its key', async () => {
    const store = ddbPaymentStore(fakeDoc(), 't1145');
    await expect(store.get('o_1#2')).rejects.toThrow();
    await expect(store.putCustomer('', 'cus_1')).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ the CheckPaymentMethod step */

function stepFixture(over: { nudgeAfterMs?: number } = {}) {
  const gateway = new FakeGateway(); const store = memoryStore();
  const emitted: OnboardingStatus[] = [];
  const clock = { now: new Date(NOW) };
  const emit = async (s: OnboardingStatus) => { emitted.push(s); };
  const run = (input: { onboardingId?: string; tenantId?: string } = { onboardingId: ONB, tenantId: TENANT }) =>
    checkPaymentMethod(input as { onboardingId: string; tenantId: string }, { gateway, store, emit, now: () => clock.now, ...over });
  return { gateway, store, emitted, clock, run };
}

describe('CheckPaymentMethod: no card yet', () => {
  it('fails with NeedsPaymentMethod and tells the owner, in plain words, where to add a card', async () => {
    const { gateway, store, emitted, run } = stepFixture();
    const err = await run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(NeedsPaymentMethodError);
    expect((err as Error).name).toBe('NeedsPaymentMethod');           // Step Functions matches on this name
    expect(emitted).toHaveLength(1);
    const s = emitted[0]!;
    expect(s).toMatchObject({ tenantId: TENANT, onboardingId: ONB, step: 'number', state: 'waiting_owner' });
    expect(s.messageForOwner).toMatch(URL_RE);
    expect(styleIssues(s.messageForOwner)).toEqual([]);
    expect(gateway.customerCreates).toBe(1);
    expect(gateway.sessions).toHaveLength(1);
    expect(store.rows.get(ONB)?.promptedAt).toBe(NOW.toISOString());
  });

  it('keeps failing on every poll, but asks only once: no repeated messages, no pile of checkout sessions', async () => {
    const { gateway, emitted, clock, run } = stepFixture();
    for (let i = 0; i < 5; i++) {
      await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
      clock.now = new Date(clock.now.getTime() + 60_000);
    }
    expect(emitted).toHaveLength(1);
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.customerCreates).toBe(1);
  });

  it('reminds the owner with a fresh link after a long quiet stretch, in different words', async () => {
    const { emitted, clock, run } = stepFixture({ nudgeAfterMs: 6 * 3600_000 });
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    clock.now = new Date(NOW.getTime() + 6 * 3600_000 - 1);
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    expect(emitted).toHaveLength(1);
    clock.now = new Date(NOW.getTime() + 6 * 3600_000);
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.messageForOwner).not.toBe(emitted[0]!.messageForOwner);
    expect(emitted[1]!.messageForOwner).toMatch(/cs_test_2/);
    expect(checkReply(emitted[1]!.messageForOwner, { channel: 'chat', previousAgentTurns: [emitted[0]!.messageForOwner] })).toEqual([]);
  });

  it('an expired card does not open the gate', async () => {
    const { gateway, run } = stepFixture();
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    gateway.attachCard('cus_1', { expMonth: 8, expYear: 2026 });
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
  });

  it('a card on a different onboarding customer does not count', async () => {
    const { gateway, run } = stepFixture();
    const other = await gateway.createCustomer('o_ffffffffffffffffffff');
    gateway.attachCard(other.customerId);
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
  });
});

describe('CheckPaymentMethod: card attached', () => {
  it('passes once the owner finished the hosted page, and thanks them in chat', async () => {
    const { gateway, emitted, run } = stepFixture();
    await expect(run()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    gateway.attachCard('cus_1', { fingerprint: 'fpAAAA1111bbbb', funding: 'prepaid' });
    const out = await run();
    expect(out).toEqual({ customerId: 'cus_1', paymentMethodId: 'pm_1', cardFingerprint: 'fpAAAA1111bbbb', funding: 'prepaid' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ tenantId: TENANT, onboardingId: ONB, step: 'number', state: 'started' });
    expect(styleIssues(emitted[1]!.messageForOwner)).toEqual([]);
    expect(checkReply(emitted[1]!.messageForOwner, { channel: 'chat', previousAgentTurns: [emitted[0]!.messageForOwner] })).toEqual([]);
  });

  it('stays quiet when there was never a request to answer (card already there)', async () => {
    const { gateway, store, emitted, run } = stepFixture();
    await store.putCustomer(ONB, 'cus_1');
    gateway.attachCard('cus_1');
    expect(await run()).toMatchObject({ customerId: 'cus_1', paymentMethodId: 'pm_1' });
    expect(emitted).toHaveLength(0);
    expect(gateway.sessions).toHaveLength(0);
  });

  it('uses a card that is valid through the end of this month, and leaves out a missing fingerprint', async () => {
    const { gateway, store, run } = stepFixture();
    await store.putCustomer(ONB, 'cus_1');
    gateway.attachCard('cus_1', { fingerprint: undefined, expMonth: 10, expYear: 2026 });
    const out = await run();
    expect(out.paymentMethodId).toBe('pm_1');
    expect('cardFingerprint' in out).toBe(false);
  });

  it('prefers the valid card when an expired one is also on file', async () => {
    const { gateway, store, run } = stepFixture();
    await store.putCustomer(ONB, 'cus_1');
    gateway.attachCard('cus_1', { paymentMethodId: 'pm_old', expMonth: 1, expYear: 2025 });
    gateway.attachCard('cus_1', { paymentMethodId: 'pm_new' });
    expect((await run()).paymentMethodId).toBe('pm_new');
  });
});

describe('CheckPaymentMethod: failure handling', () => {
  it('rejects a malformed tenant id or onboarding id before doing anything', async () => {
    const { gateway, emitted, run } = stepFixture();
    await expect(run({ onboardingId: ONB, tenantId: 'not-a-tenant' })).rejects.toThrow();
    await expect(run({ onboardingId: 'o_1#2', tenantId: TENANT })).rejects.toThrow();
    await expect(run({ onboardingId: undefined, tenantId: TENANT })).rejects.toThrow();
    await expect(run({ onboardingId: ONB })).rejects.toThrow();
    expect(gateway.customerCreates).toBe(0);
    expect(gateway.listCalls).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('Stripe being down is PaymentUnavailable (retried by the workflow), not "needs a card", and says nothing to the owner', async () => {
    const { gateway, store, emitted, run } = stepFixture();
    await store.putCustomer(ONB, 'cus_1');
    gateway.down = new PaymentUnavailableError('stripe unreachable');
    const err = await run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(PaymentUnavailableError);
    expect(err).not.toBeInstanceOf(NeedsPaymentMethodError);
    expect(emitted).toHaveLength(0);
  });

  it('if the status cannot be sent, the step fails and the owner is asked again on the retry', async () => {
    const { store, run } = stepFixture();
    let broken = true; const sent: OnboardingStatus[] = [];
    const gateway = new FakeGateway();
    const emit = async (s: OnboardingStatus) => { if (broken) throw new Error('eventbridge down'); sent.push(s); };
    const go = () => checkPaymentMethod({ onboardingId: ONB, tenantId: TENANT }, { gateway, store, emit, now: () => NOW });
    await expect(go()).rejects.toThrow('eventbridge down');
    expect(store.rows.get(ONB)?.promptedAt).toBeUndefined();          // not marked as asked
    broken = false;
    await expect(go()).rejects.toBeInstanceOf(NeedsPaymentMethodError);
    expect(sent).toHaveLength(1);
  });

  it('the status data is valid against the onboarding.status contract', async () => {
    const schema = JSON.parse(readFileSync(new URL('../../../contracts/events/events.schema.json', import.meta.url), 'utf8'));
    const def = schema.$defs['onboarding.status'];
    const { gateway, emitted, run } = stepFixture();
    await run().catch(() => undefined);
    gateway.attachCard('cus_1');
    await run();
    expect(emitted).toHaveLength(2);
    for (const s of emitted) {
      expect(def.properties.step.enum).toContain(s.step);
      expect(def.properties.state.enum).toContain(s.state);
      expect(typeof s.messageForOwner).toBe('string');
    }
  });
});

/* ------------------------------------------------------------------ the event bus */

describe('ebStatusEmitter', () => {
  const status: OnboardingStatus = { tenantId: TENANT, onboardingId: ONB, step: 'number', state: 'waiting_owner', messageForOwner: 'Hi there' };

  it('publishes an onboarding.status envelope keyed to the tenant and onboarding', async () => {
    const entries: any[] = [];
    const eb = { send: async (cmd: unknown) => { expect(cmd).toBeInstanceOf(PutEventsCommand); entries.push(...(cmd as PutEventsCommand).input.Entries!); return { FailedEntryCount: 0 }; } };
    await ebStatusEmitter(eb, 'bus-1', () => NOW)(status);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ EventBusName: 'bus-1', Source: '1145.provisioning', DetailType: 'onboarding.status' });
    expect(JSON.parse(entries[0].Detail)).toEqual({
      type: 'onboarding.status', version: 1, tenantId: TENANT, correlationId: ONB, occurredAt: NOW.toISOString(),
      data: { step: 'number', state: 'waiting_owner', messageForOwner: 'Hi there' },
    });
  });

  it('a rejected entry is a failure, not a silent drop', async () => {
    const eb = { send: async () => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] }) };
    await expect(ebStatusEmitter(eb, 'bus-1')(status)).rejects.toThrow(/onboarding\.status/);
  });
});

/* ------------------------------------------------------------------ the point of it all */

describe('no number is bought without a card on file', () => {
  /** Same shape the state machine gives these steps: check first, retry NeedsPaymentMethod, only then order. */
  it('the workflow orders nothing until a card is attached, then orders exactly once', async () => {
    const gateway = new FakeGateway(); const store = memoryStore();
    const purchases: string[] = [];
    const telnyx = { order: async (n: string) => { purchases.push(n); return { orderId: `ord${purchases.length}`, status: 'pending' }; } };
    const saved = new Map<string, { number: string; orderId: string }>();
    const orderState: OrderState = { get: async (id) => saved.get(id), put: async (id, v) => (saved.has(id) ? false : (saved.set(id, v), true)) };
    const deps = { gateway, store, emit: async () => undefined, now: () => NOW };

    const attempt = async () => {
      try { await checkPaymentMethod({ onboardingId: ONB, tenantId: TENANT }, deps); }
      catch (e) { if (e instanceof NeedsPaymentMethodError) return 'waiting'; throw e; }
      await orderNumber({ onboardingId: ONB, tenantId: TENANT, candidates: ['+12145550100'], connectionId: 'conn_1' }, { telnyx, state: orderState });
      return 'ordered';
    };

    expect(await attempt()).toBe('waiting');
    expect(await attempt()).toBe('waiting');
    expect(purchases).toHaveLength(0);

    gateway.attachCard('cus_1');
    expect(await attempt()).toBe('ordered');
    expect(await attempt()).toBe('ordered');                         // a re-run still buys nothing new
    expect(purchases).toEqual(['+12145550100']);
  });
});

describe('owner copy', () => {
  it('every line passes conversation-style for chat with zero issues and carries the link', () => {
    const url = 'https://checkout.stripe.test/c/setup/cs_test_1';
    const lines = [ownerCopy.askForCard(url), ownerCopy.remindAboutCard(url)].map((c) => c.messageForOwner);
    for (const l of lines) { expect(styleIssues(l)).toEqual([]); expect(l).toContain(url); }
    expect(ownerCopy.cardReceived().messageForOwner).not.toMatch(/https?:/);
    expect(styleIssues(ownerCopy.cardReceived().messageForOwner)).toEqual([]);
    expect(new Set([...lines, ownerCopy.cardReceived().messageForOwner]).size).toBe(3);
  });

  it('never promises a charge that the setup flow does not make', () => {
    for (const l of [ownerCopy.askForCard('https://x.test/a'), ownerCopy.remindAboutCard('https://x.test/a')].map((c) => c.messageForOwner)) {
      expect(l).not.toMatch(/\$\d|\bcharged? you\b|\bsubscription\b/i);
    }
  });
});
