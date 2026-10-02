import type { EngineAgentRef, TenantRuntimeState, VoiceEngine } from '@1145/shared';

export interface StateDeps {
  engineFor(ref: EngineAgentRef): VoiceEngine;
  loadRef(tenantId: string): Promise<EngineAgentRef>;
  writeState(tenantId: string, state: TenantRuntimeState, reasonCode: string, actor: string): Promise<void>;
  audit(entry: { tenantId: string; action: string; reasonCode: string; actor: string; at: string }): Promise<void>;
}

/** Kill switch and billing suspension go through the engine interface so they work on either engine (ADR-0001). */
export async function setTenantState(tenantId: string, state: TenantRuntimeState, reasonCode: string, actor: string, deps: StateDeps) {
  if (!reasonCode) throw new Error('reason code required');
  const ref = await deps.loadRef(tenantId);
  await deps.engineFor(ref).setTenantState(ref, state);
  await deps.writeState(tenantId, state, reasonCode, actor);
  await deps.audit({ tenantId, action: `state:${state}`, reasonCode, actor, at: new Date().toISOString() });
}
