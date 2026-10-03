import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext } from '../lib/tenant-auth.js';
import {
  allocateChange, changeStoreOf, CHANGE_TTL_MS, defaultDraw, normaliseChange, type ChangeDeps,
} from '../lib/changes.js';

/**
 * Stores a pending change and returns a short code. Nothing is applied here: the admin agent can only propose.
 * Tenant comes from the token (requireTenantContext); the body's kind/payload are validated and whitelisted.
 */
export async function proposeChange(event: HttpEvent, deps: ChangeDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'proposeChange', deps);
  const repo = await deps.repoFor(ctx.tenantId);
  const store = changeStoreOf(repo);

  const body = parseBody<{ kind?: unknown; payload?: unknown }>(event);
  const now = deps.now();
  const change = await normaliseChange(body.kind, body.payload, repo, now);

  const rec = await allocateChange(store, {
    changeId: deps.newId('chg'),
    kind: change.kind,
    payload: change.payload,
    summary: change.summary,
    requiresStepUp: change.requiresStepUp,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHANGE_TTL_MS).toISOString(),
    proposedBy: ctx.principal,
  }, deps.randomInt ?? defaultDraw, now.toISOString());

  return json(201, {
    changeId: rec.changeId,
    code: rec.code,
    summary: rec.summary,
    expiresAt: rec.expiresAt,
    requiresStepUp: rec.requiresStepUp,
    messageForOwner: rec.requiresStepUp
      ? `${rec.summary} Prices need a quick check, so open the app to confirm it.`
      : `${rec.summary} Reply CONFIRM ${rec.code} to make it official.`,
  });
}

export const handler = handle(async (e) => proposeChange(e, await (await import('../deps.js')).prodDeps()));
