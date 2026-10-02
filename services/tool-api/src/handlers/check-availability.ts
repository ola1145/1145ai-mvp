import { handle, HttpError, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { openSlots } from '../lib/slots.js';
import { isoDate, optStr } from '../lib/validate.js';

export async function checkAvailability(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'checkAvailability', deps);
  const body = parseBody<{ serviceId?: unknown; dateFrom?: unknown; dateTo?: unknown; maxResults?: unknown }>(event);
  const from = isoDate(body.dateFrom, 'dateFrom');
  const to = isoDate(body.dateTo, 'dateTo');
  if (to.getTime() - from.getTime() > 14 * 86_400_000) throw new HttpError(400, 'range_too_wide', 'max 14 days');

  const repo = await deps.repoFor(ctx.tenantId);
  const serviceId = optStr(body.serviceId, 'serviceId', 80);
  const service = serviceId ? await repo.getService(serviceId) : await repo.defaultService();
  const hours = await repo.getHours();
  if (!service || !hours) throw new HttpError(409, 'not_configured', 'hours or services missing', "I can't see the schedule right now. Can I take a message?");

  const locked = await repo.lockedInstants(from.toISOString(), to.toISOString());
  const slots = openSlots({
    hours, from, to, durationMin: service.durationMin, locked, notBefore: deps.now(),
    maxResults: Math.min(Number(body.maxResults ?? 5) || 5, 10),
  });
  return json(200, { timezone: hours.timezone, serviceId: service.serviceId, slots });
}

export const handler = handle(async (e) => checkAvailability(e, await (await import('../deps.js')).prodDeps()));
