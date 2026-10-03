export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Row = Record<string, any>;

const BASE = 'https://api.telnyx.com';
const PAGE_SIZE = 250;

/** Thin Telnyx v2 REST client (Bearer key). The key is only ever placed in the Authorization header. */
export class TelnyxClient {
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch, private readonly base = BASE) {}

  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Telnyx ${method} ${path.split('?')[0]} failed with ${res.status}: ${errorSummary(text)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Follow `meta.total_pages` so a connection on page two is never missed. */
  async list(collection: string): Promise<Row[]> {
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request<{ data?: Row[]; meta?: { total_pages?: number } }>('GET', `/v2/${collection}?page%5Bnumber%5D=${page}&page%5Bsize%5D=${PAGE_SIZE}`);
      rows.push(...(res.data ?? []));
      if (page >= (res.meta?.total_pages ?? 1) || (res.data ?? []).length === 0) return rows;
    }
  }

  async create(collection: string, body: object): Promise<Row> { return (await this.request<{ data: Row }>('POST', `/v2/${collection}`, body)).data; }
  async update(collection: string, id: string, body: object): Promise<Row> { return (await this.request<{ data: Row }>('PATCH', `/v2/${collection}/${encodeURIComponent(id)}`, body)).data; }
}

function errorSummary(text: string): string {
  try {
    const errs = (JSON.parse(text) as { errors?: { title?: string; detail?: string }[] }).errors ?? [];
    const s = errs.map((e) => [e.title, e.detail].filter(Boolean).join(': ')).join('; ');
    if (s) return s.slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 200);
}
