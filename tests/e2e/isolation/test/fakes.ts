/**
 * In-memory fakes used ONLY by the self-test. Each fake has a correct mode and several deliberately broken
 * modes. The self-test proves the isolation probes pass on the correct mode and FAIL on every broken one,
 * so a green real run cannot be a vacuous pass.
 */
import { createHmac } from 'node:crypto';
import type { DataPlanePort, DdbResult, DdbSession, HttpPort, HttpRequest, HttpResponse, RealtimePort } from '../src/types.js';

export const SEED = {
  a: { tenantId: 't_aaaaaaaa1', bookingId: 'bk_A_1', serviceId: 'svc_A_1', fact: 'Alder Dental offers a free whitening trial', ownerSub: 'sub-a-0001' },
  b: {
    tenantId: 't_bbbbbbbb1', bookingId: 'bk_B_1', serviceId: 'svc_B_1',
    firstName: 'Beatrix-Zorblax', fact: 'Zorblax Plumbing only fits left-handed wrenches', number: '+15555550142',
    ownerSub: 'sub-b-0001',
  },
  markers: ['Zorblax'],
} as const;

const SECRET = 'fake-signing-secret';
const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function mintToken(tid: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ tid, prn: 'owner', cid: 'cid-1', aud: 'tool-api' });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

// ---------------------------------------------------------------- tool API

export type ToolApiMode =
  | 'correct' | 'trust-body-tenant' | 'skip-signature' | 'accept-alg-none' | 'global-id-lookup'
  | 'global-kb' | 'write-to-body-tenant' | 'seed-missing' | 'rejects-everything' | 'server-error-on-foreign-ids';

interface Booking { bookingId: string; start: string; end: string; serviceId: string; status: 'confirmed' | 'cancelled'; customerFirstName: string }
interface TenantData { bookings: Booking[]; services: string[]; facts: string[]; messages: string[] }

export function fakeToolApi(mode: ToolApiMode): HttpPort {
  const data: Record<string, TenantData> = {
    [SEED.a.tenantId]: {
      bookings: [{ bookingId: SEED.a.bookingId, start: '2030-01-01T10:00:00Z', end: '2030-01-01T10:30:00Z', serviceId: SEED.a.serviceId, status: 'confirmed', customerFirstName: 'Alma' }],
      services: [SEED.a.serviceId], facts: [SEED.a.fact], messages: [],
    },
    [SEED.b.tenantId]: {
      bookings: mode === 'seed-missing' ? [] : [{ bookingId: SEED.b.bookingId, start: '2030-01-02T10:00:00Z', end: '2030-01-02T10:30:00Z', serviceId: SEED.b.serviceId, status: 'confirmed', customerFirstName: SEED.b.firstName }],
      services: [SEED.b.serviceId], facts: [SEED.b.fact], messages: [],
    },
  };
  const res = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) });

  function verified(token: string | null): string | null {
    if (!token) return null;
    const [h, p, s] = token.split('.');
    if (!h || !p) return null;
    let head: { alg?: string };
    try { head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string }; } catch { return null; }
    const claims = () => (JSON.parse(Buffer.from(p, 'base64url').toString()) as { tid: string }).tid;
    if (head.alg === 'none') return mode === 'accept-alg-none' ? claims() : null;
    if (mode !== 'skip-signature' && s !== createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')) return null;
    try { return claims(); } catch { return null; }
  }

  return async (req: HttpRequest) => {
    if (mode === 'rejects-everything') return res(401, { code: 'unauthorized' });
    if (req.path === '/internal/resolve/number') return res(403, { code: 'forbidden' });
    let tid = verified(req.token);
    if (!tid) return res(401, { code: 'unauthorized' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (mode === 'trust-body-tenant' || mode === 'write-to-body-tenant') {
      const claimed = (body.tenantId ?? req.query?.tenantId ?? req.headers?.['X-Tenant-Id']) as string | undefined;
      if (claimed && data[claimed] && (mode === 'trust-body-tenant' || req.path === '/v1/tools/messages')) tid = claimed;
    }
    const t = data[tid];
    if (!t) return res(404, { code: 'no_tenant' });
    if (mode === 'server-error-on-foreign-ids' && tid === SEED.a.tenantId && (req.path + JSON.stringify(body)).includes(SEED.b.bookingId)) {
      return res(500, { code: 'boom' });
    }

    const findBooking = (id: string): Booking | undefined =>
      t.bookings.find((x) => x.bookingId === id) ??
      (mode === 'global-id-lookup' ? Object.values(data).flatMap((d) => d.bookings).find((x) => x.bookingId === id) : undefined);

    const { path, method } = req;
    if (path === '/v1/admin/bookings' && method === 'GET') return res(200, t.bookings);
    const act = /^\/v1\/tools\/bookings\/([^/]+)\/(reschedule|cancel)$/.exec(path);
    if (act) {
      const bk = findBooking(decodeURIComponent(act[1]!));
      if (!bk) return res(404, { code: 'not_found' });
      if (act[2] === 'cancel') bk.status = 'cancelled';
      return res(200, bk);
    }
    if (path === '/v1/tools/availability') {
      return t.services.includes(String(body.serviceId ?? t.services[0])) ? res(200, { slots: [], timezone: 'UTC' }) : res(404, { code: 'no_service' });
    }
    if (path === '/v1/tools/bookings') {
      if (!t.services.includes(String(body.serviceId))) return res(404, { code: 'no_service' });
      t.bookings.push({ bookingId: `bk_${t.bookings.length + 100}`, start: String(body.slotStart), end: String(body.slotStart), serviceId: String(body.serviceId), status: 'confirmed', customerFirstName: String((body.customer as { name?: string } | undefined)?.name ?? '') });
      return res(201, { ok: true });
    }
    if (path === '/v1/tools/messages') { t.messages.push(String(body.body)); return res(201, { ok: true }); }
    if (path === '/v1/tools/kb/search') {
      const q = String(body.query ?? '').toLowerCase();
      const pool = mode === 'global-kb' ? Object.values(data).flatMap((d) => d.facts) : t.facts;
      return res(200, { passages: pool.filter((f) => f.toLowerCase().includes(q)).map((text) => ({ text, source: 'kb', verified: true })) });
    }
    if (path === '/v1/admin/conversations') return res(200, t.messages.map((m) => ({ summary: m })));
    if (path.startsWith('/v1/admin/services/')) {
      return t.services.includes(decodeURIComponent(path.split('/').pop()!)) ? res(200, { ok: true }) : res(404, { code: 'no_service' });
    }
    if (path === '/v1/admin/changes/apply') return res(404, { code: 'no_pending_change' });
    return res(200, { ok: true });
  };
}

// ---------------------------------------------------------------- data plane (IAM)

export type DataPlaneMode = 'correct' | 'allow-all' | 'prefix-only' | 'scan-allowed' | 'routes-readable' | 'wrong-error' | 'empty-table';

export function fakeDataPlane(mode: DataPlaneMode): DataPlanePort {
  const items = [
    { PK: `TENANT#${SEED.a.tenantId}`, SK: 'PROFILE' },
    { PK: `TENANT#${SEED.b.tenantId}`, SK: 'PROFILE' },
    { PK: `NUMBER#${SEED.b.number}`, SK: 'ROUTE' },
  ];
  const denied: DdbResult = { ok: false, errorType: 'com.amazon.coral.service#AccessDeniedException', message: 'not authorized' };
  return {
    async assumeRole(tags): Promise<DdbSession> {
      const allowedPk = `TENANT#${tags.tenant_id}`;
      const pkAllowed = (pk: string): boolean => {
        if (mode === 'allow-all') return true;
        if (mode === 'prefix-only') return pk.startsWith('TENANT#');
        if (mode === 'routes-readable' && (pk.startsWith('NUMBER#') || pk.startsWith('IDENTITY#'))) return true;
        return pk === allowedPk || pk.startsWith(`${allowedPk}#`);
      };
      const deny = (): DdbResult =>
        mode === 'wrong-error' ? { ok: false, errorType: 'com.amazon.coral.service#ResourceNotFoundException', message: 'no such table' } : denied;
      return {
        async call(op, input): Promise<DdbResult> {
          const pks: string[] = [];
          if (op === 'Query') pks.push(String((input.ExpressionAttributeValues as Record<string, { S: string }>)[':pk']!.S));
          if (op === 'GetItem') pks.push(String((input.Key as { PK: { S: string } }).PK.S));
          if (op === 'PutItem') pks.push(String((input.Item as { PK: { S: string } }).PK.S));
          if (op === 'BatchGetItem') {
            for (const t of Object.values(input.RequestItems as Record<string, { Keys: Array<{ PK: { S: string } }> }>)) for (const k of t.Keys) pks.push(k.PK.S);
          }
          if (op === 'Scan' && mode !== 'scan-allowed' && mode !== 'allow-all') return deny();
          if (!pks.every(pkAllowed)) return deny();
          if (mode === 'empty-table') return { ok: true, data: { Items: [], Count: 0 } };
          const hits = op === 'Scan' ? items : items.filter((i) => pks.includes(i.PK));
          return { ok: true, data: { Items: hits, Count: hits.length } };
        },
      };
    },
  };
}

// ---------------------------------------------------------------- realtime (AppSync Events)

export type RealtimeMode = 'correct' | 'any-tenant-channel' | 'any-owner-channel' | 'ops-open' | 'publish-open' | 'denies-everything';

export function fakeRealtime(mode: RealtimeMode): RealtimePort {
  const claims = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { 'custom:tenant_id': string; sub: string; 'cognito:groups'?: string[] };
  const allowed = (jwt: string, ch: string): boolean => {
    if (mode === 'denies-everything') return false;
    const c = claims(jwt);
    const t = /^\/tenants\/([^/]+)\/live$/.exec(ch);
    if (t) return mode === 'any-tenant-channel' || t[1] === c['custom:tenant_id'];
    const o = /^\/owners\/([^/]+)\/chat$/.exec(ch);
    if (o) return mode === 'any-owner-channel' || o[1] === c.sub;
    if (ch === '/ops/fleet') return mode === 'ops-open' || (c['cognito:groups'] ?? []).includes('ops');
    return false;
  };
  return {
    async subscribe(jwt, channel) { return allowed(jwt, channel) ? { ok: true } : { ok: false, error: 'UnauthorizedException' }; },
    // Only the publisher Lambda (IAM) may publish; a Cognito owner never can.
    async publish() { return mode === 'publish-open' ? { ok: true } : { ok: false, error: 'UnauthorizedException' }; },
  };
}

export function fakeJwt(tenantId: string, sub: string, groups: string[] = []): string {
  return `${b64({ alg: 'RS256' })}.${b64({ 'custom:tenant_id': tenantId, sub, 'cognito:groups': groups })}.sig`;
}
