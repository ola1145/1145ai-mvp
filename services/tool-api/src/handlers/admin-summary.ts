import { handle, HttpError, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';

/**
 * TODO(W1-11): implement getSummaryReport per contracts/openapi/tenant-tools.yaml.
 * Rules: see x-principals / x-requires-verification / x-requires-step-up on the operation.
 */
export async function getSummaryReport(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  await requireTenantContext(event, 'getSummaryReport', deps);
  throw new HttpError(501, 'not_implemented', 'getSummaryReport not implemented yet');
}

export const handler = handle(async (e) => getSummaryReport(e, await (await import('../deps.js')).prodDeps()));
