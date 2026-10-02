import { handle, HttpError, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';

/** TODO(W1-11): load pending change by code, enforce step-up for price changes, apply, emit admin.change_applied, audit. */
export async function applyChange(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  await requireTenantContext(event, 'applyChange', deps);
  throw new HttpError(501, 'not_implemented', 'applyChange not implemented yet');
}
export const handler = handle(async (e) => applyChange(e, await (await import('../deps.js')).prodDeps()));
