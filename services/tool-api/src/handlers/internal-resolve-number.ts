import { handle, HttpError, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { str } from '../lib/validate.js';
import { E164, prodResolverDeps, resolvedCall, type ResolverDeps } from '../lib/resolver-deps.js';

export type { ResolverDeps } from '../lib/resolver-deps.js';

/**
 * IAM-authorized (SigV4) route used by the voice worker only. The dialed number decides the tenant (the one rule):
 * `tenantId` or anything else identity-like in the body is never read.
 * The returned token is call-scoped and carries the carrier caller ID when there is one; the worker never shows it to the model.
 * Unknown number -> 404 (the worker plays its generic fallback). Suspended and over-cap tenants still resolve, with
 * `state` set, so the worker can take a message.
 */
export async function resolveNumber(event: HttpEvent, deps: ResolverDeps): Promise<HttpResult> {
  const b = parseBody<{ dialed?: unknown; caller?: unknown; callId?: unknown }>(event);
  const dialed = str(b.dialed, 'dialed', 20);
  if (!E164.test(dialed)) throw new HttpError(400, 'invalid', 'dialed must be E.164');
  const callId = str(b.callId, 'callId', 128);
  // Withheld or malformed caller ID ("anonymous") simply means the token carries no caller number.
  const caller = typeof b.caller === 'string' && E164.test(b.caller) ? b.caller : undefined;

  const route = await deps.routeForNumber(dialed);
  if (!route) throw new HttpError(404, 'unassigned', 'number not assigned', "Sorry, this number isn't set up yet.");
  return resolvedCall(deps, route, { callId, channel: 'voice', caller });
}

export const handler = handle(async (e) => resolveNumber(e, await prodResolverDeps()));
