import { randomBytes } from 'node:crypto';
import {
  asTenantId,
  type E164, type EngineAgentRef, type KnowledgeDoc, type NormalizedCallEvent, type NumberBinding,
  type TenantAgentConfig, type TenantId, type TenantRuntimeState, type VoiceEngine,
} from '@1145/shared';
import { E164_RE } from './dial-out.js';

/**
 * LiveKit on Telnyx (default engine, ADR-0002). The "agent" is configuration in OUR table: the frontdesk worker
 * resolves the tenant from sip.trunkPhoneNumber per call and loads it. So provisioning is mostly data writes;
 * the only external calls are Telnyx (assign number to the LiveKit SIP connection) and LiveKit (outbound smoke call).
 * `createLiveKitAdapterDeps` builds the concrete deps from small ports (deps.ts).
 */
export interface LiveKitAdapterDeps {
  saveRuntimeConfig(tenantId: TenantId, cfg: TenantAgentConfig): Promise<void>;
  saveVerifiedKnowledge(tenantId: TenantId, docs: KnowledgeDoc[]): Promise<void>;     // S3 Vectors index per tenant
  putNumberRoute(number: E164, tenantId: TenantId, state: TenantRuntimeState): Promise<void>;
  deleteNumberRoute(number: E164): Promise<void>;
  /** Flip `state` on every NUMBER# route the tenant owns (the resolver reads it on each call). */
  setRouteState(tenantId: TenantId, state: TenantRuntimeState): Promise<void>;
  /** ENGINEAGENT#livekit-telnyx#<agentId> -> tenant. */
  putEngineAgentRoute(agentId: string, tenantId: TenantId): Promise<void>;
  telnyxAssignToConnection(number: E164): Promise<void>;                              // number -> FQDN connection to LiveKit SIP
  /** LiveKit SipClient.createSipParticipant via the outbound trunk + AgentDispatchClient to put "frontdesk" in the room. */
  dialOut(params: { roomName: string; to: E164; fromNumber: E164; tenantId: TenantId }): Promise<string>;
  /** Events from our own worker arrive signed with a 1145 service token; LiveKit webhooks via WebhookReceiver. */
  verifyWorkerEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<NormalizedCallEvent>;
}

export interface LiveKitEngineOptions {
  now?: () => Date;
  newId?: () => string;
}

const ENGINE = 'livekit-telnyx' as const;
export const agentIdFor = (tenantId: TenantId): string => `frontdesk:${tenantId}`;

export class LiveKitTelnyxEngine implements VoiceEngine {
  readonly id = ENGINE;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private deps: LiveKitAdapterDeps, opts: LiveKitEngineOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomBytes(4).toString('hex'));
  }

  async provisionTenantAgent(tenantId: TenantId, cfg: TenantAgentConfig): Promise<EngineAgentRef> {
    const tid = asTenantId(tenantId);
    const agentId = agentIdFor(tid);
    await this.deps.putEngineAgentRoute(agentId, tid);
    await this.deps.saveRuntimeConfig(tid, cfg);
    return { engine: ENGINE, tenantId: tid, agentId };
  }

  async updateTenantAgent(ref: EngineAgentRef, cfg: TenantAgentConfig) {
    await this.deps.saveRuntimeConfig(this.tenantOf(ref), cfg);
  }

  async syncKnowledge(ref: EngineAgentRef, docs: KnowledgeDoc[]) {
    await this.deps.saveVerifiedKnowledge(this.tenantOf(ref), docs.filter((d) => d.verified));
  }

  async bindNumber(ref: EngineAgentRef, number: E164): Promise<NumberBinding> {
    const tid = this.tenantOf(ref);
    if (!E164_RE.test(number)) throw new Error('bindNumber: number is not E.164');
    await this.deps.telnyxAssignToConnection(number);
    await this.deps.putNumberRoute(number, tid, 'active');
    return { engine: ENGINE, number };
  }

  /**
   * Removes the number's route. The binding carries no tenant, so the caller (account closure) is responsible for
   * having checked ownership first; a binding from another engine is ignored rather than acted on.
   */
  async unbindNumber(binding: NumberBinding) {
    if (binding.engine !== ENGINE) return;
    await this.deps.deleteNumberRoute(binding.number);
  }

  async setTenantState(ref: EngineAgentRef, state: TenantRuntimeState) {
    await this.deps.setRouteState(this.tenantOf(ref), state);
  }

  async placeSmokeTestCall(ref: EngineAgentRef, from: E164, to: E164) {
    const tid = this.tenantOf(ref);
    // The room name is informational: the worker never reads a tenant from it.
    const roomName = `smoke-${tid}-${this.now().getTime()}-${this.newId()}`;
    const callId = await this.deps.dialOut({ roomName, to, fromNumber: from, tenantId: tid });
    return { callId };
  }

  normalizeCallEvent(rawBody: string, headers: Record<string, string | undefined>) { return this.deps.verifyWorkerEvent(rawBody, headers); }

  /** The ref comes from our own table, but check it is ours and is this tenant's before acting on it. */
  private tenantOf(ref: EngineAgentRef): TenantId {
    const tid = asTenantId(ref.tenantId);
    if (ref.engine !== ENGINE || ref.agentId !== agentIdFor(tid)) throw new Error('EngineRefMismatch: not a livekit-telnyx agent for this tenant');
    return tid;
  }
}
