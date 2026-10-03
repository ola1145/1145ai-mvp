import type { Channel, TenantId } from './tenant-context.js';

/**
 * Every EventBridge detail-type on the 1145 bus. Mirrors `type.enum` and `$defs` in
 * contracts/events/events.schema.json (enforced by packages/shared/test/events.test.ts).
 * Add new types here AND in the schema via a change request to C0; never rename or remove one.
 */
export const EVENT_TYPES = [
  'call.started', 'call.ended', 'booking.created', 'booking.updated', 'booking.cancelled',
  'message.taken', 'handoff.requested', 'conversation.message', 'onboarding.status',
  'tenant.provisioned', 'tenant.state_changed', 'channel.unlock_changed', 'usage.recorded',
  'admin.change_applied',
  // Added by CR E2-1: live transcript turns (LiveKit engine), best effort, routed only to /tenants/<tid>/live.
  'transcript.partial',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

export interface EventEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  type: EventType;
  version: 1;
  tenantId: TenantId;
  correlationId: string;
  occurredAt: string;
  data: T;
}

export function makeEvent<T extends Record<string, unknown>>(
  type: EventType,
  ctx: { tenantId: TenantId; correlationId: string },
  data: T,
  now: Date = new Date(),
): EventEnvelope<T> {
  return { type, version: 1, tenantId: ctx.tenantId, correlationId: ctx.correlationId, occurredAt: now.toISOString(), data };
}

/** Phone numbers are masked in every event that can reach a UI. */
export function maskPhone(e164: string | undefined): string {
  if (!e164) return 'unknown';
  const digits = e164.replace(/[^\d+]/g, '');
  if (digits.length < 6) return '•••';
  return `${digits.slice(0, 2)}${'•'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}

export interface CallEndedData extends Record<string, unknown> {
  callId: string;
  durationSec: number;
  endReason: 'caller_hangup' | 'agent_hangup' | 'transfer' | 'error' | 'over_cap' | 'suspended';
  transcriptKey?: string;
  engineConversationId?: string;
  channel?: Channel;
}
