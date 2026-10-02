import type {
  E164, EngineAgentRef, KnowledgeDoc, NormalizedCallEvent, NumberBinding,
  TenantAgentConfig, TenantId, TenantRuntimeState, VoiceEngine,
} from '@1145/shared';

/**
 * LiveKit on Telnyx (default engine, ADR-0002). The "agent" is configuration in OUR table: the frontdesk worker
 * resolves the tenant from sip.trunkPhoneNumber per call and loads it. So provisioning is mostly data writes;
 * the only external calls are Telnyx (assign number to the LiveKit SIP connection) and LiveKit (outbound smoke call).
 */
export interface LiveKitAdapterDeps {
  saveRuntimeConfig(tenantId: TenantId, cfg: TenantAgentConfig): Promise<void>;
  saveVerifiedKnowledge(tenantId: TenantId, docs: KnowledgeDoc[]): Promise<void>;     // S3 Vectors index per tenant
  putNumberRoute(number: E164, tenantId: TenantId, state: TenantRuntimeState): Promise<void>;
  deleteNumberRoute(number: E164): Promise<void>;
  setRouteState(tenantId: TenantId, state: TenantRuntimeState): Promise<void>;
  telnyxAssignToConnection(number: E164): Promise<void>;                              // number -> FQDN connection to LiveKit SIP
  /** LiveKit SipClient.createSipParticipant via the outbound trunk + AgentDispatchClient to put "frontdesk" in the room. */
  dialOut(params: { roomName: string; to: E164; fromNumber: E164; tenantId: TenantId }): Promise<string>;
  /** Events from our own worker arrive signed with a 1145 service token; LiveKit webhooks via WebhookReceiver. */
  verifyWorkerEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<NormalizedCallEvent>;
}

export class LiveKitTelnyxEngine implements VoiceEngine {
  readonly id = 'livekit-telnyx' as const;
  constructor(private deps: LiveKitAdapterDeps) {}

  async provisionTenantAgent(tenantId: TenantId, cfg: TenantAgentConfig): Promise<EngineAgentRef> {
    await this.deps.saveRuntimeConfig(tenantId, cfg);
    return { engine: 'livekit-telnyx', tenantId, agentId: `frontdesk:${tenantId}` };
  }
  async updateTenantAgent(ref: EngineAgentRef, cfg: TenantAgentConfig) { await this.deps.saveRuntimeConfig(ref.tenantId, cfg); }
  async syncKnowledge(ref: EngineAgentRef, docs: KnowledgeDoc[]) { await this.deps.saveVerifiedKnowledge(ref.tenantId, docs.filter((d) => d.verified)); }
  async bindNumber(ref: EngineAgentRef, number: E164): Promise<NumberBinding> {
    await this.deps.telnyxAssignToConnection(number);
    await this.deps.putNumberRoute(number, ref.tenantId, 'active');
    return { engine: 'livekit-telnyx', number };
  }
  async unbindNumber(binding: NumberBinding) { await this.deps.deleteNumberRoute(binding.number); }
  async setTenantState(ref: EngineAgentRef, state: TenantRuntimeState) { await this.deps.setRouteState(ref.tenantId, state); }
  async placeSmokeTestCall(ref: EngineAgentRef, from: E164, to: E164) {
    const callId = await this.deps.dialOut({ roomName: `smoke-${ref.tenantId}-${Date.now()}`, to, fromNumber: from, tenantId: ref.tenantId });
    return { callId };
  }
  normalizeCallEvent(rawBody: string, headers: Record<string, string | undefined>) { return this.deps.verifyWorkerEvent(rawBody, headers); }
}
