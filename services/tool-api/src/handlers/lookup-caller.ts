import { handle, json, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';

/** Caller ID is spoofable: return a first name and a boolean, nothing that would leak booking details. */
export async function lookupCaller(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'lookupCaller', deps);
  if (!ctx.callerE164) return json(200, { known: false });
  const hit = await (await deps.repoFor(ctx.tenantId)).findCustomerByPhone(ctx.callerE164);
  return json(200, hit ? { known: true, firstName: hit.firstName, hasUpcomingBooking: hit.hasUpcomingBooking } : { known: false });
}

export const handler = handle(async (e) => lookupCaller(e, await (await import('../deps.js')).prodDeps()));
