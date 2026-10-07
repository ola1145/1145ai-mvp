import { handle, header, HttpError, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext } from '../lib/tenant-auth.js';
import {
  announceApplied, appliedResponse, auditOf, normaliseServiceEdit, profileWritesOf, requireStepUp, type AppliedEdit,
  type ProfileWriteDeps,
} from '../lib/profile-writes.js';

/**
 * PATCH /v1/admin/services/{serviceId}. The owner (or staff) edits a service's name, length, price or availability.
 * Saves it, then emits admin.change_applied so the receptionist's instructions are re-rendered.
 *
 * Any priceCents in the body (even 0) needs a valid X-Step-Up-Token for this tenant, else 428 and nothing changes.
 * The service id is the path parameter and is looked up inside the caller's own tenant, so another tenant's id is a 404.
 */
export async function updateService(event: HttpEvent, deps: ProfileWriteDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'updateService', deps);
  const repo = await deps.repoFor(ctx.tenantId);
  const store = profileWritesOf(repo);
  const now = deps.now();

  const { edit, summary, requiresStepUp } = await normaliseServiceEdit(event.pathParameters?.serviceId, parseBody(event), repo, now);
  if (requiresStepUp) await requireStepUp(header(event, 'x-step-up-token'), deps, ctx.tenantId, now);

  const applied: AppliedEdit = { changeId: deps.newId('chg'), kind: 'service', summary, requiresStepUp };
  if (!(await store.patchService(edit.serviceId, edit.patch, auditOf(ctx, applied, now)))) {
    throw new HttpError(404, 'unknown_service', 'service not found', "I couldn't find that service. Which one do you mean?");
  }
  await announceApplied(ctx, deps, applied, now);
  return appliedResponse(applied);
}

export const handler = handle(async (e) => updateService(e, await (await import('../deps.js')).prodDeps()));
