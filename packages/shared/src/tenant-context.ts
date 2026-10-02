/**
 * TenantContext is built ONLY from authenticated sources (dialed number, verified channel identity,
 * Cognito claims, signed service token). There is deliberately no constructor that accepts raw model output.
 */
export type TenantId = string & { readonly __brand: 'TenantId' };
export type Principal = 'customer-agent' | 'admin-agent' | 'owner' | 'staff' | 'ops' | 'system';
export type Channel = 'voice' | 'webchat' | 'whatsapp' | 'telegram' | 'sms' | 'dashboard' | 'internal';

const TENANT_ID_RE = /^t_[a-z0-9]{8,40}$/;

export function asTenantId(raw: string): TenantId {
  if (!TENANT_ID_RE.test(raw)) throw new Error('invalid tenant id format');
  return raw as TenantId;
}

export interface TenantContext {
  readonly tenantId: TenantId;
  readonly principal: Principal;
  readonly channel: Channel;
  /** Same value across every log line and event of one interaction (call id, room name, conversation id). */
  readonly correlationId: string;
  readonly callId?: string;
  /** From carrier signalling, NOT proof of identity (caller ID is spoofable). */
  readonly callerE164?: string;
}

export const CUSTOMER_TOOLS = [
  'checkAvailability', 'createBooking', 'rescheduleBooking', 'cancelBooking',
  'takeMessage', 'searchKnowledge', 'lookupCaller', 'requestHandoff',
] as const;

/** Admin agent can READ and PROPOSE. It never applies a change: the owner confirms with a code the router handles. */
export const ADMIN_AGENT_TOOLS = [
  'checkAvailability', 'createBooking', 'rescheduleBooking', 'cancelBooking', 'searchKnowledge',
  'getSummaryReport', 'listBookings', 'listConversations', 'proposeChange',
] as const;

/** Owner (dashboard, or the router acting on a verified "CONFIRM 1234" from the owner's bound channel). */
export const OWNER_TOOLS = [...ADMIN_AGENT_TOOLS, 'updateHours', 'updateService', 'applyChange'] as const;

export type ToolName = (typeof CUSTOMER_TOOLS)[number] | (typeof OWNER_TOOLS)[number];

export function principalMayCall(principal: Principal, tool: ToolName): boolean {
  const allowed: readonly string[] =
    principal === 'customer-agent' ? CUSTOMER_TOOLS
    : principal === 'admin-agent' ? ADMIN_AGENT_TOOLS
    : principal === 'owner' || principal === 'staff' ? OWNER_TOOLS
    : [];
  return allowed.includes(tool);
}
