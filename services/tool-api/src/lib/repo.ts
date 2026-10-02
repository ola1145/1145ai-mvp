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
  searchVerifiedFacts(query: string, limit: number): Promise<Array<{ text: string; source: string; verified: boolean }>>;
}

export interface ToolDeps {
  repoFor(tenantId: string): Promise<TenantRepo>;
  publish(event: EventEnvelope): Promise<void>;
  now(): Date;
  newId(prefix: string): string;
}
