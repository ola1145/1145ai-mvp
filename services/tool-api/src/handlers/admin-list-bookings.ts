import { handle, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { bookingRange, guarded, pagedJson, parseLimit, reportsOf, safeTimezone } from '../lib/reports.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * Bookings whose appointment starts in [from, to), oldest first, as the contract's Booking array.
 * A bare date, or a date-time with no offset, is read in the tenant's timezone; Z or an offset is an exact instant.
 * Pages of `limit` (default 100, max 200); the next page's cursor is in the X-Next-Cursor header. No contact details here.
 */
export async function listBookings(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'listBookings', deps);
  const reads = reportsOf(await deps.repoFor(ctx.tenantId));
  const query = event.queryStringParameters ?? {};

  return guarded(event.requestContext.requestId, async () => {
    const limit = parseLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const { start, end } = bookingRange(query, safeTimezone(await reads.timezone()));
    const page = await reads.listBookings({ fromIso: start.toISOString(), toIso: end.toISOString(), limit, after: query.cursor || undefined });
    return pagedJson(page.items, page.next);
  });
}

export const handler = handle(async (e) => listBookings(e, await (await import('../deps.js')).prodDeps()));
