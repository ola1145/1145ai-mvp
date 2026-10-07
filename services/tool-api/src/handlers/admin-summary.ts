import { handle, json, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { guarded, reportsOf, safeTimezone, summaryLine, summaryOf, summaryRange } from '../lib/reports.js';

/**
 * Calls, bookings, messages, minutes and the sentiment mix for a range of days.
 * `from` and `to` are calendar days in the TENANT's timezone and `to` is included whole. Bookings are counted by when the
 * appointment starts, conversations and messages by when they started. Reads one tenant partition, nothing else.
 */
export async function getSummaryReport(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'getSummaryReport', deps);
  const reads = reportsOf(await deps.repoFor(ctx.tenantId));
  const query = event.queryStringParameters ?? {};

  return guarded(event.requestContext.requestId, async () => {
    const timezone = safeTimezone(await reads.timezone());
    const { from, to, start, end } = summaryRange(query, timezone);
    const summary = summaryOf(await reads.tally({ fromIso: start.toISOString(), toIso: end.toISOString() }));
    return json(200, { from, to, timezone, ...summary, sayToCaller: summaryLine(summary) });
  });
}

export const handler = handle(async (e) => getSummaryReport(e, await (await import('../deps.js')).prodDeps()));
