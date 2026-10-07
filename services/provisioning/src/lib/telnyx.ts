/**
 * Thin Telnyx v2 client for number search, ordering and assignment.
 *
 * Search is free; ordering costs money, so the only place a number is bought is `order()`, and the only caller is
 * steps/order-number.ts, which guards it with ORDER# state plus a lookup by customer_reference.
 *
 * UNVERIFIED AGAINST THE LIVE API: the filter names and response shapes below follow the public v2 reference as
 * the author understood it, and the tests use hand-written fixtures. Recording a real (free) search and confirming
 * `filter[customer_reference]` on /number_orders and PATCH /phone_numbers/{id} is an owner follow-up (see tasks/D5.md).
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const BASE = 'https://api.telnyx.com/v2';
const REQUEST_TIMEOUT_MS = 10_000;

/** The request definitely did not create anything (4xx other than 429): safe to try something else. */
export class TelnyxRejectedError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'TelnyxRejectedError'; }
}
/** Outcome unknown or retryable (network, timeout, 429, 5xx): an order may or may not exist. Never buy a second number on this. */
export class TelnyxTransientError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'TelnyxTransientError'; }
}

export interface TelnyxOrder { orderId: string; status: string; numbers: string[] }

export interface TelnyxClient {
  searchLocal(params: { areaCode?: string; locality?: string; state?: string; limit?: number }): Promise<string[]>;
  order(e164: string, connectionId: string, customerReference: string): Promise<{ orderId: string; status: string }>;
  /** Existing, non-failed order carrying this customer_reference (our idempotency key at the vendor). */
  findOrderByReference(customerReference: string): Promise<TelnyxOrder | undefined>;
  /**
   * The number's record on OUR account, if we own it (`GET /phone_numbers`, which lists only numbers on the account).
   * SEC-18: after an order whose outcome is unknown this is how a retry learns whether the number was bought, without
   * ordering again. A failure to ask is thrown as TelnyxTransientError, never answered as "not owned".
   */
  findOwnedNumber(e164: string): Promise<{ id: string } | undefined>;
  /** Point an owned number at the FQDN connection that fronts LiveKit SIP. Safe to repeat. */
  assignToConnection(e164: string, connectionId: string): Promise<void>;
}

const FAILED_STATUSES = new Set(['failure', 'failed', 'cancelled', 'canceled']);
export const isFailedOrderStatus = (status: string | undefined): boolean => !!status && FAILED_STATUSES.has(status.toLowerCase());

export function telnyxClient(apiKey: string, fetchImpl: typeof fetch = fetch): TelnyxClient {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let r: Response;
    try {
      r = await fetchImpl(`${BASE}${path}`, {
        method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new TelnyxTransientError(`telnyx ${method} ${path.split('?')[0]} network: ${String(err)}`);
    }
    if (!r.ok) {
      const msg = `telnyx ${method} ${path.split('?')[0]} ${r.status}`; // never include the response body or key
      if (r.status === 429 || r.status >= 500) throw new TelnyxTransientError(msg, r.status);
      throw new TelnyxRejectedError(msg, r.status);
    }
    try { return await r.json(); } catch { throw new TelnyxTransientError(`telnyx ${method} ${path.split('?')[0]} unreadable body`, r.status); }
  }

  /** The account's record for exactly this number. The filter is asked for an exact match and checked again here. */
  async function ownedRecord(e164: string): Promise<{ id?: string; connection_id?: string } | undefined> {
    const q = new URLSearchParams({ 'filter[phone_number]': e164 });
    const found = (await call('GET', `/phone_numbers?${q}`)) as { data?: Array<{ id?: string; phone_number?: string; connection_id?: string }> };
    return (found.data ?? []).find((d) => d.phone_number === undefined || d.phone_number === e164);
  }

  return {
    async searchLocal({ areaCode, locality, state, limit = 5 }) {
      const q = new URLSearchParams({ 'filter[country_code]': 'US', 'filter[phone_number_type]': 'local', 'filter[features][]': 'voice', 'filter[limit]': String(limit) });
      if (areaCode) q.set('filter[national_destination_code]', areaCode);
      if (locality) q.set('filter[locality]', locality);
      if (state) q.set('filter[administrative_area]', state);
      const body = (await call('GET', `/available_phone_numbers?${q}`)) as { data?: Array<{ phone_number?: string }> };
      return (body.data ?? []).map((d) => d.phone_number).filter((n): n is string => !!n);
    },

    async order(e164, connectionId, customerReference) {
      const body = (await call('POST', '/number_orders', {
        phone_numbers: [{ phone_number: e164 }], connection_id: connectionId, customer_reference: customerReference,
      })) as { data?: { id?: string; status?: string } };
      if (!body.data?.id) throw new TelnyxTransientError('telnyx order response had no id'); // may have been created: caller looks it up
      return { orderId: body.data.id, status: body.data.status ?? 'unknown' };
    },

    async findOrderByReference(customerReference) {
      const q = new URLSearchParams({ 'filter[customer_reference]': customerReference });
      const body = (await call('GET', `/number_orders?${q}`)) as {
        data?: Array<{ id?: string; status?: string; phone_numbers?: Array<{ phone_number?: string }> }>;
      };
      const live = (body.data ?? []).find((o) => o.id && !isFailedOrderStatus(o.status));
      if (!live?.id) return undefined;
      return {
        orderId: live.id, status: live.status ?? 'unknown',
        numbers: (live.phone_numbers ?? []).map((p) => p.phone_number).filter((n): n is string => !!n),
      };
    },

    async findOwnedNumber(e164) {
      const mine = await ownedRecord(e164);
      return mine?.id ? { id: mine.id } : undefined;
    },

    async assignToConnection(e164, connectionId) {
      const mine = await ownedRecord(e164);
      if (!mine?.id) throw new TelnyxTransientError(`number ${e164} not on the account yet`); // order still settling: retry
      if (mine.connection_id === connectionId) return;
      await call('PATCH', `/phone_numbers/${encodeURIComponent(mine.id)}`, { connection_id: connectionId });
    },
  };
}

/** Telnyx credentials come from one Secrets Manager JSON secret with the keys TELNYX_API_KEY and TELNYX_CONNECTION_ID. */
export interface TelnyxConfig { apiKey: string; connectionId: string }

let cached: Promise<TelnyxConfig> | undefined;
export function loadTelnyxConfig(env: NodeJS.ProcessEnv = process.env): Promise<TelnyxConfig> {
  cached ??= (async () => {
    // The stack points this at the stage's runtime secret (1145/<stage>/runtime, written by scripts/secrets/push.sh), whose JSON
    // already carries TELNYX_API_KEY and TELNYX_CONNECTION_ID. Secrets Manager takes the name or the ARN.
    const arn = env.TELNYX_SECRET_ID ?? env.TELNYX_SECRET_ARN;
    if (!arn) throw new Error('TELNYX_SECRET_ID is not set');
    const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(out.SecretString ?? '{}') as Record<string, string | undefined>;
    if (!parsed.TELNYX_API_KEY || !parsed.TELNYX_CONNECTION_ID) throw new Error('Telnyx secret is missing TELNYX_API_KEY or TELNYX_CONNECTION_ID');
    return { apiKey: parsed.TELNYX_API_KEY, connectionId: parsed.TELNYX_CONNECTION_ID };
  })().catch((e) => { cached = undefined; throw e; });
  return cached;
}
