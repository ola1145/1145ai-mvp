/**
 * Thin Telnyx v2 client for number search and ordering. Verify filter names against the current API reference
 * before W1-13 is marked done. All calls are idempotent at OUR layer (see steps/order-number.ts).
 */
const BASE = 'https://api.telnyx.com/v2';

export interface TelnyxClient {
  searchLocal(params: { areaCode?: string; locality?: string; state?: string; limit?: number }): Promise<string[]>;
  order(e164: string, connectionId: string, customerReference: string): Promise<{ orderId: string; status: string }>;
}

export function telnyxClient(apiKey: string, fetchImpl: typeof fetch = fetch): TelnyxClient {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    async searchLocal({ areaCode, locality, state, limit = 5 }) {
      const q = new URLSearchParams({ 'filter[country_code]': 'US', 'filter[phone_number_type]': 'local', 'filter[features][]': 'voice', 'filter[limit]': String(limit) });
      if (areaCode) q.set('filter[national_destination_code]', areaCode);
      if (locality) q.set('filter[locality]', locality);
      if (state) q.set('filter[administrative_area]', state);
      const r = await fetchImpl(`${BASE}/available_phone_numbers?${q}`, { headers });
      if (!r.ok) throw new Error(`telnyx search ${r.status}`);
      const body = (await r.json()) as { data?: Array<{ phone_number?: string }> };
      return (body.data ?? []).map((d) => d.phone_number).filter((n): n is string => !!n);
    },
    async order(e164, connectionId, customerReference) {
      const r = await fetchImpl(`${BASE}/number_orders`, {
        method: 'POST', headers,
        body: JSON.stringify({ phone_numbers: [{ phone_number: e164 }], connection_id: connectionId, customer_reference: customerReference }),
      });
      if (!r.ok) throw new Error(`telnyx order ${r.status}`);
      const body = (await r.json()) as { data?: { id?: string; status?: string } };
      return { orderId: body.data?.id ?? '', status: body.data?.status ?? 'unknown' };
    },
  };
}
