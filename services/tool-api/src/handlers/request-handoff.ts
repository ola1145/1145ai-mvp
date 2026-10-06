import { makeEvent } from '@1145/shared';
import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { isOpenAt } from '../lib/slots.js';
import { str } from '../lib/validate.js';

export async function requestHandoff(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'requestHandoff', deps);
  const reason = str(parseBody<{ reason?: unknown }>(event).reason, 'reason', 300);
  const repo = await deps.repoFor(ctx.tenantId);
  const number = await repo.getHandoffNumber();
  // Transfer only while the owner is reachable: their transfer window, else business hours. Nothing configured = no restriction.
  const window = (await repo.getHandoffWindow?.()) ?? (await repo.getHours());
  const available = !window || isOpenAt(window, deps.now());
  const to = number && available ? number : undefined;
  await deps.publish(makeEvent('handoff.requested', ctx, { reason, action: to ? 'transfer' : 'take_message' }));
  if (to) return json(200, { action: 'transfer', transferTo: to, sayToCaller: 'Let me connect you with someone from the team. One moment.' });
  return json(200, {
    action: 'take_message',
    sayToCaller: number
      ? "The team isn't taking calls right now. I can take a message and they'll get back to you."
      : "The team can't come to the phone right now. I can take a message and they'll call you back.",
  });
}

export const handler = handle(async (e) => requestHandoff(e, await (await import('../deps.js')).prodDeps()));
