import { asTenantId, type EngineAgentRef, type TenantRuntimeState, type VoiceEngine } from '@1145/shared';

const STATES: readonly TenantRuntimeState[] = ['active', 'suspended', 'over_cap'];

export interface StateAuditEntry {
  tenantId: string;
  action: string;
  reasonCode: string;
  actor: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface StateDeps {
  engineFor(ref: EngineAgentRef): VoiceEngine;
  loadRef(tenantId: string): Promise<EngineAgentRef>;
  writeState(tenantId: string, state: TenantRuntimeState, reasonCode: string, actor: string): Promise<void>;
  /** Must throw if the entry did not land: a change that cannot be recorded does not happen. */
  audit(entry: StateAuditEntry): Promise<void>;
  now?(): Date;
}

/** The engine reference stored on a tenant profile, or undefined when the tenant has no engine yet. */
export function engineRefFromProfile(tenantId: string, profile: Record<string, unknown>): EngineAgentRef | undefined {
  const ref = profile.engineRef;
  const agentId = typeof ref === 'string' ? ref : (ref as { agentId?: unknown } | null | undefined)?.agentId;
  const engine = profile.engine;
  if (typeof agentId !== 'string' || !agentId || (engine !== 'livekit-telnyx' && engine !== 'elevenlabs')) return undefined;
  return { engine, tenantId: asTenantId(tenantId), agentId };
}

/**
 * Kill switch and billing suspension go through the engine interface so they work on either engine (ADR-0001).
 *
 * Order matters:
 *  1. The audit entry is written FIRST. If it cannot be written nothing changes (the audit bucket is the record).
 *  2. The engine is flipped, so calls stop (or resume) before the profile says they did. If the engine fails the
 *     profile never claims a state the calls do not have.
 *  3. The profile state is written.
 * If step 2 or 3 fails, a `state:<state>_failed` entry is added (best effort) and the original error is rethrown,
 * so the caller can retry. Each attempt is its own pair of entries.
 */
export async function setTenantState(
  tenantId: string,
  state: TenantRuntimeState,
  reasonCode: string,
  actor: string,
  deps: StateDeps,
  opts: { detail?: Record<string, unknown> } = {},
): Promise<void> {
  if (typeof reasonCode !== 'string' || !reasonCode.trim()) throw new Error('reason code required');
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('actor required');
  if (!STATES.includes(state)) throw new Error(`invalid state: ${String(state)}`);
  asTenantId(tenantId);

  const ref = await deps.loadRef(tenantId);
  if (ref.tenantId !== tenantId) throw new Error('engine reference belongs to another tenant');

  const at = () => (deps.now?.() ?? new Date()).toISOString();
  const base = { tenantId, reasonCode, actor };
  await deps.audit({ ...base, action: `state:${state}`, at: at(), ...(opts.detail ? { detail: opts.detail } : {}) });
  try {
    await deps.engineFor(ref).setTenantState(ref, state);
    await deps.writeState(tenantId, state, reasonCode, actor);
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await deps.audit({ ...base, action: `state:${state}_failed`, at: at(), detail: { ...opts.detail, error } }).catch(() => undefined);
    throw e;
  }
}
