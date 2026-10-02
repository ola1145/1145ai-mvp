import { makeEvent, maskPhone } from '@1145/shared';
import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { optStr, str } from '../lib/validate.js';

export async function takeMessage(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'takeMessage', deps);
  const b = parseBody<Record<string, unknown>>(event);
  const urgency = b.urgency === 'urgent' ? 'urgent' : 'normal';
  const callbackNumber = optStr(b.callbackNumber, 'callbackNumber', 20) ?? ctx.callerE164;
  const id = await (await deps.repoFor(ctx.tenantId)).putMessage({
    fromName: str(b.fromName, 'fromName', 120), callbackNumber, body: str(b.body, 'body', 2000), urgency, at: deps.now().toISOString(),
  });
  // Owner notification is a subscriber of message.taken (admin channel), not done inline.
  await deps.publish(makeEvent('message.taken', ctx, { messageId: id, urgency, callbackMasked: maskPhone(callbackNumber) }));
  return json(201, { messageId: id, sayToCaller: "Got it. I've passed your message to the team and they'll get back to you." });
}

export const handler = handle(async (e) => takeMessage(e, await (await import('../deps.js')).prodDeps()));
