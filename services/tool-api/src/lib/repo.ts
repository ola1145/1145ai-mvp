import type { BusinessHours } from './slots.js';
import type { EventEnvelope } from '@1145/shared';

export interface Service { serviceId: string; name: string; durationMin: number; priceCents?: number; active: boolean }

export interface BookingRecord {
  bookingId: string;
  start: string;
  end: string;
  serviceId: string;
  status: 'confirmed' | 'cancelled';
  customer: { name: string; phone?: string; email?: string };
  via: string;
  createdAt: string;
}

export class SlotTakenError extends Error { constructor() { super('slot taken'); } }
export class IdempotentReplay extends Error { constructor() { super('idempotent replay'); } }

/** Every method is implicitly scoped to ONE tenant: the factory receives the tenant id and the
 *  implementation uses credentials whose IAM policy only allows that tenant's partition (ADR-0003). */
export interface TenantRepo {
  getHours(): Promise<BusinessHours | undefined>;
  getService(serviceId: string): Promise<Service | undefined>;
  defaultService(): Promise<Service | undefined>;
  lockedInstants(fromIso: string, toIso: string): Promise<Set<string>>;
  getIdempotent(key: string): Promise<unknown | undefined>;
  /** Atomic: booking + slot locks + idempotency record. Throws SlotTakenError or IdempotentReplay. */
  book(input: { booking: BookingRecord; slotIsos: string[]; idempotencyKey: string; response: unknown }): Promise<void>;
  findCustomerByPhone(e164: string): Promise<{ firstName: string; hasUpcomingBooking: boolean } | undefined>;
  putMessage(msg: { fromName: string; callbackNumber?: string; body: string; urgency: string; at: string }): Promise<string>;
  getHandoffNumber(): Promise<string | undefined>;
  /** Owner's "transfer only during" window (profile.handoffWindow). Optional so older repos keep working;
   *  when absent the handler falls back to business hours. */
  getHandoffWindow?(): Promise<BusinessHours | undefined>;
  searchVerifiedFacts(query: string, limit: number): Promise<Array<{ text: string; source: string; verified: boolean }>>;
}

/** What the vector index is asked. `tenantId` always comes from the verified context, never the request body. */
export interface KnowledgeQuery {
  tenantId: string;
  text: string;
  topK: number;
  verifiedOnly: boolean;
  /** S3 Vectors metadata filter built by knowledgeFilter(); implementations pass it straight to QueryVectors. */
  filter: Record<string, unknown>;
}
export interface KnowledgeHit { text: string; source: string; verified: boolean; tenantId: string; score?: number }
/** Semantic search over a tenant's knowledge (S3 Vectors in prod). The handler re-checks every hit, so an index
 *  that ignores the filter still cannot leak another tenant's or an unverified passage to a customer. */
export interface KnowledgeIndex { query(q: KnowledgeQuery): Promise<KnowledgeHit[]> }

/** S3 Vectors metadata filter: tenant partition always, owner-verified when the caller is a customer-facing agent. */
export function knowledgeFilter(tenantId: string, verifiedOnly: boolean): Record<string, unknown> {
  const clauses: Array<Record<string, unknown>> = [{ tenantId: { $eq: tenantId } }];
  if (verifiedOnly) clauses.push({ verified: { $eq: true } });
  return { $and: clauses };
}

export interface ToolDeps {
  repoFor(tenantId: string): Promise<TenantRepo>;
  publish(event: EventEnvelope): Promise<void>;
  now(): Date;
  newId(prefix: string): string;
  /** Optional until the S3 Vectors client is wired in deps.ts; handlers fall back to repo.searchVerifiedFacts. */
  knowledge?: KnowledgeIndex;
}
