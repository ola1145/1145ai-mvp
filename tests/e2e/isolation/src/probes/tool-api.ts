/**
 * Probe 1: token A against every tool route with tenant B's ids in path, query, body and headers.
 * Passes only if no B data comes back, nothing A sent lands in B, and B's data is unchanged afterwards.
 */
import { fail, pass, type Finding } from '../findings.js';
import { algNoneToken, leaks, tamperTokenTid } from '../leak.js';
import { ROUTES, smearTenantB, type RouteCase, type RouteCtx } from '../routes.js';
import type { HttpPort, HttpRequest, HttpResponse } from '../types.js';

export interface ToolApiProbeConfig {
  a: { tenantId: string; token: string };
  b: { tenantId: string; token: string; bookingId: string; serviceId: string; number?: string };
  /** Strings that exist only in tenant B's data (names, knowledge text). Any appearance in A's view is a leak. */
  markers: string[];
  /** Unique per run. */
  canary: string;
}

const LIST_BOOKINGS = ROUTES.find((r) => r.operationId === 'listBookings')!;
const LIST_CONVERSATIONS = ROUTES.find((r) => r.operationId === 'listConversations')!;
const SEARCH_KB = ROUTES.find((r) => r.operationId === 'searchKnowledge')!;

async function send(http: HttpPort, req: HttpRequest): Promise<HttpResponse | { error: string }> {
  try { return await http(req); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
const isErr = (r: HttpResponse | { error: string }): r is { error: string } => 'error' in r;

function toRequest(route: RouteCase, token: string | null, ctx: RouteCtx, smear: boolean): HttpRequest {
  const built = route.build(ctx);
  const b = smear ? smearTenantB(built, route.method, ctx.bTenantId) : built;
  return { method: route.method, path: b.path, query: b.query, headers: b.headers, body: b.body, token };
}

function parseBookings(body: string): Array<{ bookingId?: string; status?: string }> | null {
  try { const j: unknown = JSON.parse(body); return Array.isArray(j) ? (j as Array<{ bookingId?: string; status?: string }>) : null; } catch { return null; }
}

export async function runToolApiProbes(http: HttpPort, cfg: ToolApiProbeConfig): Promise<Finding[]> {
  const out: Finding[] = [];
  const ctx: RouteCtx = {
    bTenantId: cfg.b.tenantId, bBookingId: cfg.b.bookingId, bServiceId: cfg.b.serviceId,
    bNumber: cfg.b.number ?? '+15555550100', marker: cfg.markers[0] ?? '', canary: cfg.canary,
  };

  // ---- Controls: without these, every "denied" below could just mean "bad token" or "no data seeded".
  const aList = await send(http, toRequest(LIST_BOOKINGS, cfg.a.token, ctx, false));
  if (isErr(aList) || aList.status !== 200) {
    out.push(fail('control:a-token-works', `token A could not list its own bookings (${isErr(aList) ? aList.error : `HTTP ${aList.status}`}); denials would prove nothing`));
    return out;
  }
  out.push(pass('control:a-token-works'));

  const bList = await send(http, toRequest(LIST_BOOKINGS, cfg.b.token, ctx, false));
  const bBookings = isErr(bList) || bList.status !== 200 ? null : parseBookings(bList.body);
  const bSeed = bBookings?.find((x) => x.bookingId === cfg.b.bookingId);
  if (!bSeed || bSeed.status !== 'confirmed') {
    out.push(fail('control:b-sees-own-booking', `tenant B's own token must see booking ${cfg.b.bookingId} as confirmed before the run; seed tenant B first`));
    return out;
  }
  if (!isErr(bList) && leaks(bList.body, cfg.markers).length === 0) {
    out.push(fail('control:b-sees-own-booking', `none of the markers ${JSON.stringify(cfg.markers)} appear in B's own bookings; the markers must be real B data or leaks cannot be detected`));
    return out;
  }
  out.push(pass('control:b-sees-own-booking'));

  // ---- Every route, token A, tenant B ids everywhere.
  const aBodies: string[] = [];
  for (const route of ROUTES) {
    const check = `tool:${route.operationId}`;
    const r = await send(http, toRequest(route, cfg.a.token, ctx, true));
    if (isErr(r)) { out.push(fail(check, `request failed: ${r.error}`)); continue; }
    aBodies.push(r.body);
    const found = leaks(route.leakView ? route.leakView(r.body) : r.body, cfg.markers);
    if (found.length) out.push(fail(check, `HTTP ${r.status}: response contains tenant B data ${JSON.stringify(found)}`));
    else if (r.status >= 500) out.push(fail(check, `HTTP ${r.status}: server error when handed tenant B ids (must be a clean 4xx or an answer scoped to A)`));
    else if (route.mustDeny && !(r.status >= 400 && r.status < 500)) out.push(fail(check, `HTTP ${r.status}: token A was allowed to act on an object that belongs to tenant B (expected 4xx)`));
    else out.push(pass(check, `HTTP ${r.status}`));
  }

  // ---- Token forgery: swapping the tenant claim must not switch tenants.
  const forged: Array<[string, string | null]> = [
    ['token:missing', null],
    ['token:garbage', 'not-a-token'],
    ['token:tampered-tid', tamperTokenTid(cfg.a.token, cfg.b.tenantId)],
    ['token:alg-none', algNoneToken(cfg.b.tenantId, 'owner')],
  ];
  for (const [check, token] of forged) {
    const r = await send(http, toRequest(LIST_BOOKINGS, token, ctx, true));
    if (isErr(r)) { out.push(fail(check, `request failed: ${r.error}`)); continue; }
    const found = leaks(r.body, cfg.markers);
    if (found.length) out.push(fail(check, `HTTP ${r.status}: forged credential returned tenant B data ${JSON.stringify(found)}`));
    else if (r.status !== 401 && r.status !== 403) out.push(fail(check, `HTTP ${r.status}: forged or missing credential must be rejected with 401 or 403`));
    else out.push(pass(check, `HTTP ${r.status}`));
  }

  // ---- Afterwards, through B's own token: nothing of A's attempts may have changed or landed in B.
  const after = await send(http, toRequest(LIST_BOOKINGS, cfg.b.token, ctx, false));
  const afterBookings = isErr(after) || after.status !== 200 ? null : parseBookings(after.body);
  const stillThere = afterBookings?.find((x) => x.bookingId === cfg.b.bookingId);
  if (!stillThere) out.push(fail('post:b-booking-untouched', `tenant B's booking ${cfg.b.bookingId} is gone or unreadable after token A's attempts`));
  else if (stillThere.status !== 'confirmed') out.push(fail('post:b-booking-untouched', `tenant B's booking is now "${stillThere.status}": token A changed it`));
  else out.push(pass('post:b-booking-untouched'));

  const bViews: string[] = [];
  for (const [route, req] of [
    [LIST_BOOKINGS, toRequest(LIST_BOOKINGS, cfg.b.token, ctx, false)],
    [LIST_CONVERSATIONS, toRequest(LIST_CONVERSATIONS, cfg.b.token, ctx, false)],
    [SEARCH_KB, { ...toRequest(SEARCH_KB, cfg.b.token, ctx, false), body: { query: cfg.canary } }],
  ] as Array<[RouteCase, HttpRequest]>) {
    const r = await send(http, req);
    if (isErr(r) || r.status !== 200) {
      out.push(fail('post:no-canary-in-b', `could not read ${route.operationId} as tenant B (${isErr(r) ? r.error : `HTTP ${r.status}`}); cannot prove nothing was written`));
      return out;
    }
    bViews.push(route === SEARCH_KB && route.leakView ? route.leakView(r.body) : r.body);
  }
  const wrote = bViews.some((v) => v.includes(cfg.canary));
  out.push(wrote ? fail('post:no-canary-in-b', 'data sent with token A (canary) is visible in tenant B: a write landed in the wrong tenant') : pass('post:no-canary-in-b'));
  return out;
}
