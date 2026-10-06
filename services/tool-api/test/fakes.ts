import { mintTenantToken, type EventEnvelope } from '@1145/shared';
import { IdempotentReplay, SlotTakenError, type KnowledgeHit, type KnowledgeIndex, type KnowledgeQuery, type TenantRepo, type ToolDeps, type BookingRecord } from '../src/lib/repo.js';
import type { AuthDeps } from '../src/lib/tenant-auth.js';
import type { HttpEvent } from '../src/lib/http.js';
import type { BusinessHours } from '../src/lib/slots.js';

export const SECRET = 'test-secret';
export const HOURS: BusinessHours = {
  timezone: 'America/Chicago',
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '17:00' })),
};

export class MemoryRepo implements TenantRepo {
  bookings: BookingRecord[] = [];
  locks = new Set<string>();
  idem = new Map<string, unknown>();
  hours: BusinessHours | undefined = HOURS;
  handoffNumber: string | undefined;
  handoffWindow: BusinessHours | undefined;
  facts: Array<{ text: string; source: string; verified: boolean }> = [];
  async getHours() { return this.hours; }
  async getService(id: string) { return id === 'cut' ? { serviceId: 'cut', name: 'Haircut', durationMin: 30, active: true } : undefined; }
  async defaultService() { return this.getService('cut'); }
  async lockedInstants() { return new Set(this.locks); }
  async getIdempotent(k: string) { return this.idem.get(k); }
  async book({ booking, slotIsos, idempotencyKey, response }: { booking: BookingRecord; slotIsos: string[]; idempotencyKey: string; response: unknown }) {
    if (this.idem.has(idempotencyKey)) throw new IdempotentReplay();
    if (slotIsos.some((s) => this.locks.has(s))) throw new SlotTakenError();
    slotIsos.forEach((s) => this.locks.add(s));
    this.bookings.push(booking);
    this.idem.set(idempotencyKey, response);
  }
  customer: { firstName: string; hasUpcomingBooking: boolean } | undefined;
  async findCustomerByPhone() { return this.customer; }
  async putMessage() { return 'msg_1'; }
  async getHandoffNumber() { return this.handoffNumber; }
  async getHandoffWindow() { return this.handoffWindow; }
  /** Mirrors the DynamoDB keyword path: returns matches with their verified flag; the handler filters by principal. */
  async searchVerifiedFacts(query: string, limit: number) {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return this.facts.filter((f) => terms.some((t) => f.text.toLowerCase().includes(t))).slice(0, limit);
  }
}

/** Fake S3 Vectors index. Records every query so tests can assert the tenant + verified filter. With `leaky` it
 *  ignores the filter, which proves the handler re-checks results instead of trusting the index. */
export class FakeKnowledgeIndex implements KnowledgeIndex {
  queries: KnowledgeQuery[] = [];
  hits: KnowledgeHit[] = [];
  fail = false;
  constructor(public leaky = false) {}
  async query(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
    this.queries.push(q);
    if (this.fail) throw new Error('index down');
    if (this.leaky) return this.hits.slice(0, q.topK);
    return this.hits.filter((h) => h.tenantId === q.tenantId && (!q.verifiedOnly || h.verified)).slice(0, q.topK);
  }
}

export function makeDeps(repos: Record<string, MemoryRepo>, now = new Date('2026-10-02T15:00:00Z'), knowledge?: KnowledgeIndex) {
  const published: EventEnvelope[] = [];
  const repoCalls: string[] = [];
  let n = 0;
  const deps: ToolDeps & AuthDeps = {
    repoFor: async (tid) => { repoCalls.push(tid); const r = repos[tid]; if (!r) throw new Error(`no repo for ${tid}`); return r; },
    publish: async (e) => { published.push(e); },
    now: () => now,
    knowledge,
    newId: (p) => `${p}_${++n}`,
    tokenSecrets: async () => [SECRET],
    engineSecret: async () => 'engine-secret',
    tenantForEngineAgent: async (id) => (id === 'agent_A' ? 't_tenanta01' : undefined),
  };
  return { deps, published, repoCalls };
}

export function voiceEvent(body: unknown, opts: { tid?: string; caller?: string; idem?: string; prn?: 'customer-agent' | 'admin-agent' } = {}): HttpEvent {
  const token = mintTenantToken({ tid: opts.tid ?? 't_tenanta01', prn: opts.prn ?? 'customer-agent', cid: 'call-1', clr: opts.caller ?? '+12145550123', ch: 'voice' }, SECRET);
  return {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': opts.idem ?? 'idem-0001' },
    body: JSON.stringify(body),
    requestContext: { requestId: 'req-1' },
  };
}
