import { makeEvent } from '@1145/shared';
import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { str } from '../lib/validate.js';

export async function requestHandoff(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'requestHandoff', deps);
  const reason = str(parseBody<{ reason?: unknown }>(event).reason, 'reason', 300);
  const to = await (await deps.repoFor(ctx.tenantId)).getHandoffNumber();
  await deps.publish(makeEvent('handoff.requested', ctx, { reason, action: to ? 'transfer' : 'take_message' }));
  // TODO(W1-11): respect owner availability window ("transfer only during open hours") from profile.
  return json(200, to
    ? { action: 'transfer', transferTo: to, sayToCaller: 'Let me connect you with someone from the team. One moment.' }
    : { action: 'take_message', sayToCaller: "The team can't come to the phone right now. I can take a message and they'll call you back." });
}

export const handler = handle(async (e) => requestHandoff(e, await (await import('../deps.js')).prodDeps()));
