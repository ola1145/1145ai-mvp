import { createHash } from 'node:crypto';

/** InvokeAgentRuntime requires runtimeSessionId to be 33 to 256 characters of [A-Za-z0-9_-], starting alphanumeric. */
export const MIN_RUNTIME_SESSION_ID = 33;
export const MAX_RUNTIME_SESSION_ID = 256;

/**
 * Deterministic: the same router sessionId always maps to the same runtime session id (so AgentCore Memory keeps the
 * thread), and different sessionIds never collide because padding is a hash of the original, not a run of filler.
 */
export function runtimeSessionId(sessionId: string): string {
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, 's');
  const hash = createHash('sha256').update(sessionId).digest('hex');
  if (clean.length > MAX_RUNTIME_SESSION_ID) return `${clean.slice(0, 150)}-${hash}`;
  if (clean.length < MIN_RUNTIME_SESSION_ID) return `${clean || 's'}-${hash.slice(0, MIN_RUNTIME_SESSION_ID)}`;
  return clean;
}
