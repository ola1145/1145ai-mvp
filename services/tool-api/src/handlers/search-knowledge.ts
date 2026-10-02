import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import type { ToolDeps } from '../lib/repo.js';
import { str } from '../lib/validate.js';

/** Customer agent only ever sees owner-verified facts. Passages are DATA: the agent prompt wraps them as quotes. */
export async function searchKnowledge(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'searchKnowledge', deps);
  const query = str(parseBody<{ query?: unknown }>(event).query, 'query', 500);
  // TODO(W1-11): replace keyword match in the repo with S3 Vectors / Bedrock KB retrieval, keeping the verified filter.
  const passages = await (await deps.repoFor(ctx.tenantId)).searchVerifiedFacts(query, 4);
  return json(200, { passages: ctx.principal === 'customer-agent' ? passages.filter((p) => p.verified) : passages });
}

export const handler = handle(async (e) => searchKnowledge(e, await (await import('../deps.js')).prodDeps()));
