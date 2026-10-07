import { handle, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext } from '../lib/tenant-auth.js';
import {
  announceApplied, appliedResponse, auditOf, normaliseHoursEdit, profileWritesOf, type AppliedEdit, type ProfileWriteDeps,
} from '../lib/profile-writes.js';

/**
 * PUT /v1/admin/hours. The owner (or staff) edits the weekly schedule in the dashboard. Saves it, then emits
 * admin.change_applied so the receptionist's instructions are re-rendered from the new hours.
 *
 * No step-up: hours are not a price. `closedDates` replaces the stored list only when the body includes it.
 * Tenant comes from the token or Cognito claim (requireTenantContext); the body is never read for identity.
 */
export async function updateHours(event: HttpEvent, deps: ProfileWriteDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'updateHours', deps);
  const repo = await deps.repoFor(ctx.tenantId);
  const store = profileWritesOf(repo);
  const now = deps.now();

  const { edit, summary, requiresStepUp } = await normaliseHoursEdit(parseBody(event), repo, now);
  const applied: AppliedEdit = { changeId: deps.newId('chg'), kind: 'hours', summary, requiresStepUp };

  await store.putHours(edit, auditOf(ctx, applied, now));
  await announceApplied(ctx, deps, applied, now);
  return appliedResponse(applied);
}

export const handler = handle(async (e) => updateHours(e, await (await import('../deps.js')).prodDeps()));
