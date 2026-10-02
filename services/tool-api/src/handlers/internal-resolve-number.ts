import { mintTenantToken } from '@1145/shared';
import { handle, HttpError, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { str } from '../lib/validate.js';

export interface ResolverDeps {
  routeForNumber(e164: string): Promise<{ tid: string; state: 'active' | 'suspended' | 'over_cap' } | undefined>;
  runtimeConfig(tid: string): Promise<{
    agentName: string; businessName: string; timezone: string; disclosureLine: string;
    instructions: string; voiceId?: string; language: string; templateVersion: string;
  }>;
  signingSecret(): Promise<string>;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * IAM-authorized (SigV4) route used by the voice worker only. The dialed number decides the tenant (the one rule).
 * The returned token is call-scoped and carries the carrier caller ID; the worker never shows it to the model.
 */
export async function resolveNumber(event: HttpEvent, deps: ResolverDeps): Promise<HttpResult> {
  const b = parseBody<{ dialed?: unknown; caller?: unknown; callId?: unknown }>(event);
  const dialed = str(b.dialed, 'dialed', 20);
  if (!E164.test(dialed)) throw new HttpError(400, 'invalid', 'dialed must be E.164');
  const callId = str(b.callId, 'callId', 128);
  const caller = typeof b.caller === 'string' && E164.test(b.caller) ? b.caller : undefined;

  const route = await deps.routeForNumber(dialed);
  if (!route) throw new HttpError(404, 'unassigned', 'number not assigned');
  const agent = await deps.runtimeConfig(route.tid);
  const token = mintTenantToken({ tid: route.tid, prn: 'customer-agent', cid: callId, clr: caller, ch: 'voice' }, await deps.signingSecret(), 3600);
  return json(200, { tenantId: route.tid, token, state: route.state, agent });
}

export const handler = handle(async () => {
  // TODO(W1-11): wire ResolverDeps (route read with the execution role, runtime config from PROFILE.rendered*, secret from SM).
  throw new HttpError(501, 'not_implemented', 'resolver deps not wired');
});
