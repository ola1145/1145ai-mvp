import { makeEvent } from '@1145/shared';
import { handle, header, HttpError, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext } from '../lib/tenant-auth.js';
import {
  changeStoreOf, notFound, stepUpRequired, stepUpSecretsOf, verifyStepUpToken, type AuditEntry, type ChangeDeps,
} from '../lib/changes.js';

/**
 * Applies a pending change by its 4-digit code. Owner only (the router mints an owner token from the verified
 * channel identity; the dashboard uses the Cognito owner). Price changes also need X-Step-Up-Token.
 */
export async function applyChange(event: HttpEvent, deps: ChangeDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'applyChange', deps);
  // Staff may pass the tool allow-list, but applying changes is the owner's call.
  if (ctx.principal !== 'owner') throw new HttpError(403, 'forbidden', `${ctx.principal} may not apply changes`, "Only the owner can confirm changes.");

  const { code } = parseBody<{ code?: unknown }>(event);
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) {
    throw new HttpError(400, 'invalid', 'code must be 4 digits', "That code should be four digits. Can you send it again?");
  }

  const store = changeStoreOf(await deps.repoFor(ctx.tenantId));
  const now = deps.now();
  const nowIso = now.toISOString();

  const rec = await store.getByCode(code);
  if (!rec || rec.status !== 'pending' || rec.expiresAt <= nowIso) throw notFound();

  if (rec.requiresStepUp) {
    const ok = verifyStepUpToken(header(event, 'x-step-up-token'), await stepUpSecretsOf(deps), ctx.tenantId, Math.floor(now.getTime() / 1000));
    if (!ok) throw stepUpRequired();
  }

  const audit: AuditEntry = {
    changeId: rec.changeId, kind: rec.kind, summary: rec.summary, principal: ctx.principal, channel: ctx.channel,
    stepUp: rec.requiresStepUp, at: nowIso, correlationId: ctx.correlationId,
  };
  // Atomic: status flip + payload write + audit. A concurrent confirm loses here and sees "not found".
  if (!(await store.commitApplied(rec, audit))) throw notFound();

  await deps.publish(makeEvent('admin.change_applied', ctx, {
    changeId: rec.changeId, kind: rec.kind, summary: rec.summary, requiresStepUp: rec.requiresStepUp,
    appliedBy: ctx.principal, via: ctx.channel,
  }, now));

  return json(200, {
    changeId: rec.changeId, kind: rec.kind, summary: rec.summary,
    messageForOwner: `Done. ${rec.summary}`,
  });
}

export const handler = handle(async (e) => applyChange(e, await (await import('../deps.js')).prodDeps()));
