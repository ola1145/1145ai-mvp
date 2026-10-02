import {
  asTenantId, principalMayCall, verifyTenantToken, safeEqual, TokenError,
  type TenantContext, type ToolName, type Principal,
} from '@1145/shared';
import { header, HttpError, type HttpEvent } from './http.js';

export interface AuthDeps {
  /** Current + previous signing secrets (rotation). Loaded from Secrets Manager and cached. */
  tokenSecrets(): Promise<readonly string[]>;
  /** ElevenAgents fallback engine: shared workspace secret sent as a header. */
  engineSecret(): Promise<string | undefined>;
  /** ElevenAgents: map system__agent_id (system-populated dynamic variable) -> tenant id via ENGINEAGENT# route. */
  tenantForEngineAgent(agentId: string): Promise<string | undefined>;
}

/**
 * The ONLY way handlers obtain a tenant. Sources, in order:
 * 1. Cognito JWT (dashboard): custom:tenant_id set by the pre-token-generation trigger, never user-editable.
 * 2. Engine secret + system-populated agent id (ElevenAgents webhook tools).
 * 3. 1145 tenant token (voice worker, AgentCore agents).
 * A tenant id in the request BODY is never read.
 */
export async function requireTenantContext(event: HttpEvent, tool: ToolName, deps: AuthDeps): Promise<TenantContext> {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (claims?.['custom:tenant_id']) {
    const principal: Principal = claims['custom:role'] === 'staff' ? 'staff' : 'owner';
    return finish(asTenantId(claims['custom:tenant_id']), principal, 'dashboard', event.requestContext.requestId, tool);
  }

  const engineSecretHeader = header(event, 'x-1145-engine-secret');
  if (engineSecretHeader) {
    const expected = await deps.engineSecret();
    if (!expected || !safeEqual(engineSecretHeader, expected)) throw new HttpError(401, 'unauthorized', 'bad engine secret');
    const agentId = header(event, 'x-1145-engine-agent-id'); // mapped from {{system__agent_id}} in the tool's header config
    if (!agentId) throw new HttpError(401, 'unauthorized', 'missing engine agent id');
    const tid = await deps.tenantForEngineAgent(agentId);
    if (!tid) throw new HttpError(403, 'forbidden', 'unknown engine agent');
    const convId = header(event, 'x-1145-conversation-id') ?? event.requestContext.requestId;
    return finish(asTenantId(tid), 'customer-agent', 'voice', convId, tool);
  }

  const auth = header(event, 'authorization');
  if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized', 'missing bearer token');
  try {
    const c = verifyTenantToken(auth.slice(7), await deps.tokenSecrets());
    const ctx = finish(asTenantId(c.tid), c.prn, (c.ch as TenantContext['channel']) ?? 'voice', c.cid ?? event.requestContext.requestId, tool);
    return { ...ctx, callId: c.cid, callerE164: c.clr };
  } catch (err) {
    if (err instanceof TokenError) throw new HttpError(401, 'unauthorized', err.message);
    throw err;
  }
}

function finish(tenantId: TenantContext['tenantId'], principal: Principal, channel: TenantContext['channel'], correlationId: string, tool: ToolName): TenantContext {
  if (!principalMayCall(principal, tool)) throw new HttpError(403, 'forbidden', `${principal} may not call ${tool}`);
  return { tenantId, principal, channel, correlationId };
}
