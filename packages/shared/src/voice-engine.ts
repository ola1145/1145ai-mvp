import type { TenantId } from './tenant-context.js';

export type EngineId = 'livekit-telnyx' | 'elevenlabs';
export type E164 = string;

export interface TenantAgentConfig {
  agentName: string;
  businessName: string;
  timezone: string;
  language: string;
  voiceId?: string;
  disclosureLine: string;       // "Hi, this is Ava, the AI assistant for X. This call may be recorded."
  instructions: string;         // rendered from pinned template + owner-confirmed profile
  templateVersion: string;
  handoffNumber?: E164;
}

export interface KnowledgeDoc {
  id: string;
  text: string;
  source: string;
  verified: boolean;            // only verified docs reach the customer agent
}

export interface EngineAgentRef {
  engine: EngineId;
  tenantId: TenantId;
  agentId: string;              // ElevenLabs agent_id, or LiveKit config key
}

export interface NumberBinding {
  engine: EngineId;
  number: E164;
  engineNumberId?: string;      // e.g. ElevenLabs phone_number_id
}

export type TenantRuntimeState = 'active' | 'suspended' | 'over_cap';

export interface NormalizedCallEvent {
  type: 'call.started' | 'call.ended' | 'transcript.partial';
  engine: EngineId;
  tenantId: TenantId;
  callId: string;
  occurredAt: string;
  durationSec?: number;
  transcript?: Array<{ role: 'agent' | 'caller'; text: string; atSec: number }>;
  analysis?: { summary?: string; sentiment?: 'positive' | 'neutral' | 'negative' };
  raw?: unknown;
}

/**
 * Every engine-specific call goes through this interface (ADR-0001).
 * Implementations: engines/livekit-adapter, engines/elevenlabs-adapter.
 */
export interface VoiceEngine {
  readonly id: EngineId;
  provisionTenantAgent(tenantId: TenantId, cfg: TenantAgentConfig): Promise<EngineAgentRef>;
  updateTenantAgent(ref: EngineAgentRef, cfg: TenantAgentConfig): Promise<void>;
  syncKnowledge(ref: EngineAgentRef, docs: KnowledgeDoc[]): Promise<void>;
  bindNumber(ref: EngineAgentRef, number: E164): Promise<NumberBinding>;
  unbindNumber(binding: NumberBinding): Promise<void>;
  setTenantState(ref: EngineAgentRef, state: TenantRuntimeState): Promise<void>;
  placeSmokeTestCall(ref: EngineAgentRef, from: E164, to: E164): Promise<{ callId: string }>;
  /** Verifies the vendor signature, then maps the payload. Throws on bad signature. */
  normalizeCallEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<NormalizedCallEvent>;
}
