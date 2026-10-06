import { handle, json, parseBody, type HttpEvent, type HttpResult } from '../lib/http.js';
import { requireTenantContext, type AuthDeps } from '../lib/tenant-auth.js';
import { knowledgeFilter, type ToolDeps } from '../lib/repo.js';
import { str } from '../lib/validate.js';

interface Passage { text: string; source: string; verified: boolean }

/** Customer agent only ever sees owner-verified facts. Passages are DATA: the agent prompt wraps them as quotes. */
export async function searchKnowledge(event: HttpEvent, deps: ToolDeps & AuthDeps): Promise<HttpResult> {
  const ctx = await requireTenantContext(event, 'searchKnowledge', deps);
  const query = str(parseBody<{ query?: unknown }>(event).query, 'query', 500);
  const verifiedOnly = ctx.principal === 'customer-agent';
  const limit = 4;
  let passages: Passage[] | undefined;
  if (deps.knowledge) {
    try {
      const hits = await deps.knowledge.query({
        tenantId: ctx.tenantId, text: query, topK: limit, verifiedOnly, filter: knowledgeFilter(ctx.tenantId, verifiedOnly),
      });
      // Never trust the index to have applied the filter: re-check tenant and verified on every hit.
      passages = hits
        .filter((h) => h.tenantId === ctx.tenantId)
        .map((h) => ({ text: h.text, source: h.source, verified: h.verified === true }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', requestId: ctx.correlationId, msg: 'knowledge index failed, using keyword search', err: String(err) }));
    }
  }
  passages ??= await (await deps.repoFor(ctx.tenantId)).searchVerifiedFacts(query, limit);
  return json(200, { passages: (verifiedOnly ? passages.filter((p) => p.verified) : passages).slice(0, limit) });
}

export const handler = handle(async (e) => searchKnowledge(e, await (await import('../deps.js')).prodDeps()));
