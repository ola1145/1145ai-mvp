import type { Channel, TenantId } from './tenant-context.js';

export type EventType =
  | 'call.started' | 'call.ended' | 'booking.created' | 'booking.updated' | 'booking.cancelled'
  | 'message.taken' | 'handoff.requested' | 'conversation.message' | 'onboarding.status'
  | 'tenant.provisioned' | 'tenant.state_changed' | 'channel.unlock_changed' | 'usage.recorded'
  | 'admin.change_applied';

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
