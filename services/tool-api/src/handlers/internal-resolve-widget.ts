import { handle, HttpError, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { str } from '../lib/validate.js';
import { prodResolverDeps, resolvedCall, WIDGET_KEY, type ResolverDeps } from '../lib/resolver-deps.js';

const unknownWidget = () => new HttpError(404, 'unknown_widget', 'widget not found', "Sorry, this chat isn't set up yet.");

/**
 * Resolve a customer web chat widget key to tenant runtime config + call-scoped token (IAM route, used by the worker only).
 * Contract: contracts/openapi/channels.yaml#/paths/~1internal~1resolve~1widget (CR E5-1).
 *
 * The widget key is the only identity input: the worker reads it from room metadata that the token endpoint set
 * server-side. The room name (`callId`) is a correlation id and is never parsed for a tenant. The token is a
 * customer-agent token with ch=webchat and no caller number, whatever the body says. Unknown, malformed or disabled
 * key -> 404 (the worker says the chat isn't set up and closes the room).
 */
export async function resolveWidget(event: HttpEvent, deps: ResolverDeps): Promise<HttpResult> {
  const b = parseBody<{ widgetKey?: unknown; callId?: unknown }>(event);
  const widgetKey = str(b.widgetKey, 'widgetKey', 256);
  const callId = str(b.callId, 'callId', 128);
  if (!WIDGET_KEY.test(widgetKey)) throw unknownWidget(); // cannot be one of ours: do not touch the table

  const route = await deps.routeForWidget(widgetKey);
  if (!route) throw unknownWidget();
  return resolvedCall(deps, route, { callId, channel: 'webchat' });
}

export const handler = handle(async (e) => resolveWidget(e, await prodResolverDeps()));
