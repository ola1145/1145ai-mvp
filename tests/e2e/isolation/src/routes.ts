/**
 * One probe per operation in contracts/openapi/tenant-tools.yaml (test/routes-drift.test.ts keeps this in sync).
 * Each request is sent with tenant A's token but carries tenant B's identifiers EVERYWHERE a careless handler
 * might read them: path, query, JSON body and headers.
 */

export interface RouteCtx {
  bTenantId: string;
  bBookingId: string;
  bServiceId: string;
  bNumber: string;
  /** A string seeded only in tenant B (used as a knowledge search query). */
  marker: string;
  /** Unique per run; written into A's requests so we can prove nothing landed in B. */
  canary: string;
}

export interface BuiltRequest {
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteCase {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** The OpenAPI path template, e.g. /v1/tools/bookings/{bookingId}/cancel. */
  template: string;
  /**
   * True when the request names an object that exists only in tenant B (or is not reachable with a tenant
   * token at all). A 2xx is then itself the leak; the only acceptable answer is a 4xx.
   */
  mustDeny: boolean;
  build(c: RouteCtx): BuiltRequest;
  /** Which part of the response body is scanned for B's markers. Defaults to the whole body. */
  leakView?(body: string): string;
}

const FROM = '2020-01-01T00:00:00Z';
const TO = '2040-01-01T00:00:00Z';
const SLOT = '2030-03-01T15:00:00Z';

export const ROUTES: RouteCase[] = [
  { operationId: 'checkAvailability', method: 'POST', template: '/v1/tools/availability', mustDeny: false,
    build: (c) => ({ path: '/v1/tools/availability', body: { dateFrom: FROM, dateTo: '2030-01-08T00:00:00Z', serviceId: c.bServiceId } }) },
  { operationId: 'createBooking', method: 'POST', template: '/v1/tools/bookings', mustDeny: true,
    build: (c) => ({ path: '/v1/tools/bookings', headers: { 'Idempotency-Key': `${c.canary}-create` },
      body: { slotStart: SLOT, serviceId: c.bServiceId, notes: c.canary, customer: { name: c.canary, phone: '+15555550199' } } }) },
  { operationId: 'rescheduleBooking', method: 'POST', template: '/v1/tools/bookings/{bookingId}/reschedule', mustDeny: true,
    build: (c) => ({ path: `/v1/tools/bookings/${encodeURIComponent(c.bBookingId)}/reschedule`, headers: { 'Idempotency-Key': `${c.canary}-resched` },
      body: { slotStart: SLOT, verificationCode: '000000' } }) },
  { operationId: 'cancelBooking', method: 'POST', template: '/v1/tools/bookings/{bookingId}/cancel', mustDeny: true,
    build: (c) => ({ path: `/v1/tools/bookings/${encodeURIComponent(c.bBookingId)}/cancel`, headers: { 'Idempotency-Key': `${c.canary}-cancel` },
      body: { reason: c.canary, verificationCode: '000000' } }) },
  { operationId: 'takeMessage', method: 'POST', template: '/v1/tools/messages', mustDeny: false,
    build: (c) => ({ path: '/v1/tools/messages', body: { fromName: c.canary, body: c.canary, callbackNumber: '+15555550199', urgency: 'normal' } }) },
  { operationId: 'searchKnowledge', method: 'POST', template: '/v1/tools/kb/search', mustDeny: false,
    build: (c) => ({ path: '/v1/tools/kb/search', body: { query: c.marker } }),
    // The response may legitimately echo our query; only the returned passages count.
    leakView: (body) => {
      try { const j = JSON.parse(body) as { passages?: unknown }; return JSON.stringify(j.passages ?? j); } catch { return body; }
    } },
  { operationId: 'lookupCaller', method: 'POST', template: '/v1/tools/caller/lookup', mustDeny: false,
    build: (c) => ({ path: '/v1/tools/caller/lookup', body: { callerE164: c.bNumber, caller: c.bNumber, phone: c.bNumber } }) },
  { operationId: 'requestHandoff', method: 'POST', template: '/v1/tools/handoff', mustDeny: false,
    build: (c) => ({ path: '/v1/tools/handoff', body: { reason: c.canary } }) },
  { operationId: 'getSummaryReport', method: 'GET', template: '/v1/admin/reports/summary', mustDeny: false,
    build: () => ({ path: '/v1/admin/reports/summary', query: { from: '2020-01-01', to: '2040-01-01' } }) },
  { operationId: 'listBookings', method: 'GET', template: '/v1/admin/bookings', mustDeny: false,
    build: () => ({ path: '/v1/admin/bookings', query: { from: FROM, to: TO } }) },
  { operationId: 'updateHours', method: 'PUT', template: '/v1/admin/hours', mustDeny: false,
    build: () => ({ path: '/v1/admin/hours', body: { timezone: 'America/Chicago', weekly: [{ day: 1, open: '09:00', close: '17:00' }] } }) },
  { operationId: 'updateService', method: 'PATCH', template: '/v1/admin/services/{serviceId}', mustDeny: true,
    build: (c) => ({ path: `/v1/admin/services/${encodeURIComponent(c.bServiceId)}`, body: { name: c.canary, active: false } }) },
  { operationId: 'proposeChange', method: 'POST', template: '/v1/admin/changes', mustDeny: false,
    build: (c) => ({ path: '/v1/admin/changes', body: { kind: 'service', payload: { serviceId: c.bServiceId, name: c.canary } } }) },
  { operationId: 'applyChange', method: 'POST', template: '/v1/admin/changes/apply', mustDeny: true,
    build: () => ({ path: '/v1/admin/changes/apply', body: { code: '0000' } }) },
  { operationId: 'listConversations', method: 'GET', template: '/v1/admin/conversations', mustDeny: false,
    build: () => ({ path: '/v1/admin/conversations', query: { limit: '50' } }) },
  // Service-IAM only: a tenant token must never be accepted here.
  { operationId: 'resolveNumber', method: 'POST', template: '/internal/resolve/number', mustDeny: true,
    build: (c) => ({ path: '/internal/resolve/number', body: { dialed: c.bNumber, caller: '+15555550100', callId: c.canary } }) },
];

/** Adds tenant B's id to every channel a handler could read it from. */
export function smearTenantB(req: BuiltRequest, method: string, bTenantId: string): BuiltRequest {
  const out: BuiltRequest = { ...req };
  out.query = { ...(req.query ?? {}), tenantId: bTenantId };
  out.headers = { ...(req.headers ?? {}), 'X-Tenant-Id': bTenantId, 'X-1145-Tenant-Id': bTenantId };
  if (method !== 'GET') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    out.body = { ...body, tenantId: bTenantId, tid: bTenantId, tenant_id: bTenantId };
  }
  return out;
}
