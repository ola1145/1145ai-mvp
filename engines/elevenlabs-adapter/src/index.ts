import {
  asTenantId,
  type E164, type EngineAgentRef, type KnowledgeDoc, type NormalizedCallEvent, type NumberBinding,
  type TenantAgentConfig, type TenantId, type TenantRuntimeState, type VoiceEngine,
} from '@1145/shared';
import { callerE164FromPhoneCall } from './caller.js';
import { MemoryEventDedupe, type EventDedupe } from './dedupe.js';
import { SIGNATURE_TOLERANCE_SEC, verifyElevenLabsSignature } from './signature.js';

export { MemoryEventDedupe, SIGNATURE_TOLERANCE_SEC };
export type { EventDedupe };

/**
 * ElevenAgents adapter (fallback engine, ADR-0002). Endpoint paths and payload shapes are verified against the
 * ElevenLabs API definition (elevenlabs-js @ ec61f8e); live captures from the W0-03 spike should replace the
 * recorded responses in test/fixtures when they exist.
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

/** A correctly signed webhook of a type we don't map (post_call_audio, call_initiation_failure). Acknowledge and drop. */
export class UnsupportedEventError extends Error {
  constructor(readonly eventType: string) { super(`unsupported elevenlabs webhook type: ${eventType}`); }
}

/**
 * A signed webhook for a conversation we already delivered (SEC-30). Acknowledge it (200) and drop it: the provider
 * retries on anything else. If the hand-off of the first delivery failed, call `releaseEvent(callId)` before answering
 * with an error so the provider's retry is accepted.
 */
export class DuplicateEventError extends Error {
  constructor(readonly callId: string) { super(`duplicate elevenlabs webhook for conversation ${callId}`); }
}

/** What `normalizeCallEvent` returns: the shared shape plus the caller's number when the call record has one (CR G2-3). */
export type ElevenCallEvent = NormalizedCallEvent & {
  /** Carrier caller ID of an inbound call, E.164. Belongs in the stored transcript object, not on the event bus. */
  callerE164?: string;
};

type KbLocator = { type: string; id: string; name: string };

const BASE = 'https://api.elevenlabs.io';
/** A delivery can only be replayed while its signature is fresh, so remember a conversation a little longer than that. */
const DEDUPE_TTL_SEC = 2 * SIGNATURE_TOLERANCE_SEC;

export class ElevenAgentsEngine implements VoiceEngine {
  readonly id = 'elevenlabs' as const;
  constructor(
    private cfg: ElevenAgentsConfig, private routes: RouteStore, private http: typeof fetch = fetch,
    private nowSec: () => number = () => Math.floor(Date.now() / 1000),
    private seen: EventDedupe = new MemoryEventDedupe(nowSec),
  ) {}

  private async call<T>(path: string, method: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<T> {
    const r = await this.http(`${BASE}${path}`, {
      method, headers: { 'xi-api-key': this.cfg.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 404 && opts.allow404) return {} as T;
    if (!r.ok) throw new Error(`elevenlabs ${method} ${path} -> ${r.status}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : {}) as T;
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

  /** Uploads verified docs, swaps the agent's knowledge base to them, then deletes the documents they superseded. */
  async syncKnowledge(ref: EngineAgentRef, docs: KnowledgeDoc[]) {
    const agent = await this.call<{ conversation_config?: { agent?: { prompt?: { knowledge_base?: KbLocator[] } } } }>(
      `/v1/convai/agents/${ref.agentId}`, 'GET');
    const previous = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
    const next: KbLocator[] = [];
    for (const d of docs.filter((doc) => doc.verified)) {
      const r = await this.call<{ id: string }>('/v1/convai/knowledge-base/text', 'POST', { text: d.text, name: d.id });
      next.push({ type: 'text', id: r.id, name: d.id });
    }
    await this.call(`/v1/convai/agents/${ref.agentId}`, 'PATCH', { conversation_config: { agent: { prompt: { knowledge_base: next } } } });
    const keep = new Set(next.map((k) => k.id));
    for (const old of previous) {
      if (!keep.has(old.id)) await this.call(`/v1/convai/knowledge-base/${old.id}`, 'DELETE', undefined, { allow404: true });
    }
  }

  async bindNumber(ref: EngineAgentRef, number: E164): Promise<NumberBinding> {
    const { address, username, password } = this.cfg.sipTrunk;
    const r = await this.call<{ phone_number_id: string }>('/v1/convai/phone-numbers', 'POST', {
      provider: 'sip_trunk', phone_number: number, label: ref.tenantId, agent_id: ref.agentId,
      inbound_trunk_config: {},
      outbound_trunk_config: { address, ...(username ? { credentials: { username, password } } : {}) },
    });
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

  /**
   * `callId` is the ElevenLabs `conversation_id`, which is also `data.conversation_id` on the post-call webhook, so
   * it is the id `normalizeCallEvent` puts on `call.ended` (D8-3: the smoke call looks the result up by it). The SIP
   * call id is not the same thing and is never returned in its place: with no conversation id the call could never
   * be matched to its result, so that is an error.
   */
  async placeSmokeTestCall(ref: EngineAgentRef, _from: E164, to: E164) {
    const binding = await this.routes.getBinding(ref.tenantId);
    if (!binding?.engineNumberId) throw new Error('number not bound');
    const r = await this.call<{ success: boolean; message: string; conversation_id?: string | null; sip_call_id?: string | null }>(
      '/v1/convai/sip-trunk/outbound-call', 'POST', { agent_id: ref.agentId, agent_phone_number_id: binding.engineNumberId, to_number: to });
    if (!r.success) throw new Error(`elevenlabs smoke call failed: ${r.message}`);
    if (!r.conversation_id) throw new Error('elevenlabs smoke call placed but returned no conversation id');
    return { callId: r.conversation_id };
  }

  /**
   * Verifies the signature (five-minute window), maps the payload and drops a second delivery of the same
   * conversation. Order matters: only a validly signed payload for a known agent can use up a conversation id, so
   * a forged request can't block the real one.
   */
  async normalizeCallEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<ElevenCallEvent> {
    const sig = Object.entries(headers).find(([k]) => k.toLowerCase() === 'elevenlabs-signature')?.[1];
    if (!verifyElevenLabsSignature(rawBody, sig, this.cfg.webhookSecret, SIGNATURE_TOLERANCE_SEC, this.nowSec())) throw new Error('bad signature');
    const p = JSON.parse(rawBody) as {
      type?: string; event_timestamp?: number;
      data?: { agent_id?: string; conversation_id?: string; transcript?: Array<{ role?: string; message?: string | null; time_in_call_secs?: number }>;
        metadata?: { call_duration_secs?: number; phone_call?: unknown }; analysis?: { transcript_summary?: string } };
    };
    if (p.type !== 'post_call_transcription') throw new UnsupportedEventError(p.type ?? 'missing');
    const agentId = p.data?.agent_id ?? '';
    const tenantId = await this.routes.tenantForAgent(agentId);
    if (!tenantId) throw new Error('unknown agent');
    const callId = p.data?.conversation_id;
    if (!callId) throw new Error('missing conversation id');
    if (!(await this.seen.claim(callId, DEDUPE_TTL_SEC))) throw new DuplicateEventError(callId);
    const callerE164 = callerE164FromPhoneCall(p.data?.metadata?.phone_call);
    return {
      type: 'call.ended', engine: 'elevenlabs', tenantId: asTenantId(tenantId), callId,
      occurredAt: new Date((p.event_timestamp ?? this.nowSec()) * 1000).toISOString(),
      durationSec: p.data?.metadata?.call_duration_secs,
      transcript: (p.data?.transcript ?? []).map((t) => ({ role: t.role === 'agent' ? 'agent' as const : 'caller' as const, text: t.message ?? '', atSec: t.time_in_call_secs ?? 0 })),
      analysis: { summary: p.data?.analysis?.transcript_summary },
      ...(callerE164 ? { callerE164 } : {}),
    };
  }

  /** Forget a delivered conversation: call this when handing the event on failed, before answering the webhook with an error. */
  async releaseEvent(callId: string): Promise<void> {
    await this.seen.release?.(callId);
  }
}
