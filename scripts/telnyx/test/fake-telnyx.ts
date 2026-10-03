type Item = Record<string, any>;
export interface TelnyxState { outbound_voice_profiles: Item[]; fqdn_connections: Item[]; fqdns: Item[]; credential_connections: Item[] }
export interface Call { method: string; path: string; body?: Item }

const COLLECTIONS = ['outbound_voice_profiles', 'fqdn_connections', 'fqdns', 'credential_connections'] as const;

/**
 * In-memory stand-in for the Telnyx v2 REST API, seeded from a hand-written fixture. Lists are paginated with the real
 * `{ data, meta }` envelope (page size is small on purpose so the client has to follow pages). Passwords are accepted on
 * create but never returned, like the real API.
 */
export class FakeTelnyx {
  calls: Call[] = [];
  private n = 0;
  constructor(public state: TelnyxState, private readonly apiKey: string, private readonly pageSize = 2) {}

  get mutations(): Call[] { return this.calls.filter((c) => c.method !== 'GET'); }
  clearCalls(): void { this.calls = []; }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${this.apiKey}`) return this.json({ errors: [{ title: 'Authentication failed' }] }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Item) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });

    const [, v2, collection, id] = url.pathname.split('/');
    if (v2 !== 'v2' || !COLLECTIONS.includes(collection as (typeof COLLECTIONS)[number])) return this.json({ errors: [{ title: 'Not found' }] }, 404);
    const rows = this.state[collection as keyof TelnyxState];

    if (method === 'GET' && !id) {
      let list = rows;
      const byConn = url.searchParams.get('filter[connection_id]');
      if (byConn) list = list.filter((r) => r.connection_id === byConn);
      const size = Number(url.searchParams.get('page[size]') ?? this.pageSize) || this.pageSize;
      const eff = Math.min(size, this.pageSize);
      const page = Number(url.searchParams.get('page[number]') ?? 1);
      const total = Math.max(1, Math.ceil(list.length / eff));
      return this.json({ data: list.slice((page - 1) * eff, page * eff), meta: { page_number: page, page_size: eff, total_pages: total, total_results: list.length } });
    }
    if (method === 'POST' && !id) {
      const { password: _pw, ...rest } = body ?? {};
      const row = { id: `9${String(++this.n).padStart(18, '0')}`, record_type: collection, ...rest };
      rows.push(row);
      return this.json({ data: row }, 201);
    }
    if (method === 'PATCH' && id) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) return this.json({ errors: [{ title: 'Resource not found' }] }, 404);
      const { password: _pw, ...rest } = body ?? {};
      rows[idx] = deepMerge(rows[idx] as Item, rest);
      return this.json({ data: rows[idx] });
    }
    return this.json({ errors: [{ title: 'Not implemented in fake' }] }, 405);
  };

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
}

function deepMerge(base: Item, patch: Item): Item {
  const out: Item = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge((base[k] as Item) ?? {}, v as Item) : v;
  return out;
}
