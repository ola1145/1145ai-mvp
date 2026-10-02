import { handle, HttpError, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';

/** TODO(W1-11): store CHANGE#<changeId> with a 4-digit code (unique per tenant, 30-min TTL); return a human summary. */
export async function proposeChange(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  await requireTenantContext(event, 'proposeChange', deps);
  throw new HttpError(501, 'not_implemented', 'proposeChange not implemented yet');
}
export const handler = handle(async (e) => proposeChange(e, await (await import('../deps.js')).prodDeps()));
