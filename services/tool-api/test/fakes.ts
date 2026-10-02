import { mintTenantToken, type EventEnvelope } from '@1145/shared';
import { IdempotentReplay, SlotTakenError, type TenantRepo, type ToolDeps, type BookingRecord } from '../src/lib/repo.js';
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
  async getHours() { return HOURS; }
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
  async findCustomerByPhone() { return undefined; }
  async putMessage() { return 'msg_1'; }
  async getHandoffNumber() { return undefined; }
  async searchVerifiedFacts() { return []; }
}

export function makeDeps(repos: Record<string, MemoryRepo>, now = new Date('2026-10-02T15:00:00Z')) {
  const published: EventEnvelope[] = [];
  const repoCalls: string[] = [];
  let n = 0;
  const deps: ToolDeps & AuthDeps = {
    repoFor: async (tid) => { repoCalls.push(tid); const r = repos[tid]; if (!r) throw new Error(`no repo for ${tid}`); return r; },
    publish: async (e) => { published.push(e); },
    now: () => now,
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
