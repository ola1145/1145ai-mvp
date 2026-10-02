import {
  asTenantId,
  type E164, type EngineAgentRef, type KnowledgeDoc, type NormalizedCallEvent, type NumberBinding,
  type TenantAgentConfig, type TenantId, type TenantRuntimeState, type VoiceEngine,
} from '@1145/shared';
import { verifyElevenLabsSignature } from './signature.js';

/**
 * ElevenAgents adapter (fallback engine, ADR-0002). Endpoint paths and payload shapes follow the ElevenLabs
 * Agents API as researched; W1-15 must verify each one against the live API reference and the W0-03 spike.
 * Webhook tools on the TEMPLATE agent point at the tenant tool API with headers:
 *   X-1145-Engine-Secret: <workspace secret>   X-1145-Engine-Agent-Id: {{system__agent_id}}
 *   X-1145-Conversation-Id: {{system__conversation_id}}
 * Those values are system-populated, never LLM-filled, which preserves the one rule.
 */
export interface ElevenAgentsConfig {
  apiKey: string;
  webhookSecret: string;
  templateAgentId: string;        // agent with tools, disclosure, guardrails configured once
  suspendedAgentId: string;       // shared "take a message / account paused" agent
  sipTrunk: { address: string; username?: string; password?: string };
}

export interface RouteStore {
  putEngineAgentRoute(agentId: string, tenantId: TenantId): Promise<void>;
  tenantForAgent(agentId: string): Promise<TenantId | undefined>;
  getBinding(tenantId: TenantId): Promise<NumberBinding | undefined>;
}

const BASE = 'https://api.elevenlabs.io';

export class ElevenAgentsEngine implements VoiceEngine {
  readonly id = 'elevenlabs' as const;
  constructor(private cfg: ElevenAgentsConfig, private routes: RouteStore, private http: typeof fetch = fetch) {}

  private async call<T>(path: string, method: string, body?: unknown): Promise<T> {
    const r = await this.http(`${BASE}${path}`, {
      method, headers: { 'xi-api-key': this.cfg.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`elevenlabs ${method} ${path} -> ${r.status}`);
    return (r.status === 204 ? {} : await r.json()) as T;
  }

  private agentPatch(cfg: TenantAgentConfig) {
    return {
      name: `${cfg.businessName} · ${cfg.agentName}`,
      conversation_config: {
        agent: { first_message: cfg.disclosureLine, language: cfg.language.slice(0, 2), prompt: { prompt: cfg.instructions } },
        ...(cfg.voiceId ? { tts: { voice_id: cfg.voiceId } } : {}),
      },
      tags: [`template:${cfg.templateVersion}`],
    };
  }

  async provisionTenantAgent(tenantId: TenantId, cfg: TenantAgentConfig): Promise<EngineAgentRef> {
    const dup = await this.call<{ agent_id: string }>(`/v1/convai/agents/${this.cfg.templateAgentId}/duplicate`, 'POST', { name: cfg.businessName });
    await this.call(`/v1/convai/agents/${dup.agent_id}`, 'PATCH', this.agentPatch(cfg));
    await this.routes.putEngineAgentRoute(dup.agent_id, tenantId);
    return { engine: 'elevenlabs', tenantId, agentId: dup.agent_id };
  }

  async updateTenantAgent(ref: EngineAgentRef, cfg: TenantAgentConfig) {
    await this.call(`/v1/convai/agents/${ref.agentId}`, 'PATCH', this.agentPatch(cfg));
  }

  async syncKnowledge(ref: EngineAgentRef, docs: KnowledgeDoc[]) {
    const verified = docs.filter((d) => d.verified);
    const ids: Array<{ type: 'text'; id: string; name: string }> = [];
    for (const d of verified) {
      const r = await this.call<{ id: string }>('/v1/convai/knowledge-base/text', 'POST', { text: d.text, name: d.id });
      ids.push({ type: 'text', id: r.id, name: d.id });
    }
    await this.call(`/v1/convai/agents/${ref.agentId}`, 'PATCH', { conversation_config: { agent: { prompt: { knowledge_base: ids } } } });
    // TODO(W1-15): delete superseded KB documents.
  }

  async bindNumber(ref: EngineAgentRef, number: E164): Promise<NumberBinding> {
    const r = await this.call<{ phone_number_id: string }>('/v1/convai/phone-numbers', 'POST', {
      phone_number: number, label: ref.tenantId, provider: 'sip_trunk',
      inbound_trunk_config: {}, outbound_trunk_config: { address: this.cfg.sipTrunk.address, credentials: this.cfg.sipTrunk.username ? { username: this.cfg.sipTrunk.username, password: this.cfg.sipTrunk.password } : undefined },
    });
    await this.call(`/v1/convai/phone-numbers/${r.phone_number_id}`, 'PATCH', { agent_id: ref.agentId });
    return { engine: 'elevenlabs', number, engineNumberId: r.phone_number_id };
  }

  async unbindNumber(binding: NumberBinding) {
    if (binding.engineNumberId) await this.call(`/v1/convai/phone-numbers/${binding.engineNumberId}`, 'DELETE');
  }

  async setTenantState(ref: EngineAgentRef, state: TenantRuntimeState) {
    const binding = await this.routes.getBinding(ref.tenantId);
    if (!binding?.engineNumberId) return;
    const agent_id = state === 'active' ? ref.agentId : this.cfg.suspendedAgentId;
    await this.call(`/v1/convai/phone-numbers/${binding.engineNumberId}`, 'PATCH', { agent_id });
  }

  async placeSmokeTestCall(ref: EngineAgentRef, _from: E164, to: E164) {
    const binding = await this.routes.getBinding(ref.tenantId);
    if (!binding?.engineNumberId) throw new Error('number not bound');
    const r = await this.call<{ conversation_id?: string; callSid?: string }>('/v1/convai/sip-trunk/outbound-call', 'POST', {
      agent_id: ref.agentId, agent_phone_number_id: binding.engineNumberId, to_number: to,
    });
    return { callId: r.conversation_id ?? r.callSid ?? 'unknown' };
  }

  async normalizeCallEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<NormalizedCallEvent> {
    const sig = headers['elevenlabs-signature'] ?? headers['ElevenLabs-Signature'];
    if (!verifyElevenLabsSignature(rawBody, sig, this.cfg.webhookSecret)) throw new Error('bad signature');
    const p = JSON.parse(rawBody) as {
      type?: string; event_timestamp?: number;
      data?: { agent_id?: string; conversation_id?: string; transcript?: Array<{ role?: string; message?: string; time_in_call_secs?: number }>;
        metadata?: { call_duration_secs?: number }; analysis?: { transcript_summary?: string } };
    };
    const agentId = p.data?.agent_id ?? '';
    const tenantId = await this.routes.tenantForAgent(agentId);
    if (!tenantId) throw new Error('unknown agent');
    return {
      type: 'call.ended', engine: 'elevenlabs', tenantId: asTenantId(tenantId), callId: p.data?.conversation_id ?? '',
      occurredAt: new Date((p.event_timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      durationSec: p.data?.metadata?.call_duration_secs,
      transcript: (p.data?.transcript ?? []).map((t) => ({ role: t.role === 'agent' ? 'agent' as const : 'caller' as const, text: t.message ?? '', atSec: t.time_in_call_secs ?? 0 })),
      analysis: { summary: p.data?.analysis?.transcript_summary },
    };
  }
}
