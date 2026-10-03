/**
 * Ports the Gate scenario talks through. The scenario never knows whether it is driving the deployed dev stack
 * (live adapters in live.ts) or the in-memory fake (fakes/fake-platform.ts), so the harness itself is testable
 * without AWS, Telnyx, Telegram or Stripe.
 *
 * Tenant identity rule (1145-tenant-isolation): no port takes a tenant id from the caller side. The phone port
 * dials a number, the customer chat port opens a widget key, the owner port acts as the signed-in owner. The
 * tenant is always resolved server-side; the platform port only reads it back to verify.
 */
export type Surface = 'owner-chat' | 'customer-chat' | 'telegram' | 'phone';
export type Channel = 'voice' | 'chat';

export interface Turn {
  surface: Surface;
  /** One conversation = one call, one chat session, one Telegram thread. Style checks run per conversation. */
  conversationId: string;
  role: 'agent' | 'user';
  text: string;
}

export interface ReferralPort {
  /** GET /r/<code> without following the redirect. */
  follow(code: string): Promise<{ status: number; location: string }>;
}

export interface OwnerPort {
  /** Google sign-in is replaced by a pre-minted Cognito test identity; the harness never handles Google credentials. */
  signIn(): Promise<{ ownerId: string }>;
  /** Owner web chat: onboarding before the tenant exists, copilot after. Returns the agent replies it caused. */
  send(text: string, opts?: { referralCode?: string }): Promise<string[]>;
  /** Stripe test-mode card (never a real card). */
  addTestCard(): Promise<void>;
}

export interface CustomerChatPort {
  open(widgetKey: string): Promise<{ agentName: string; greeting: string }>;
  send(text: string): Promise<string[]>;
}

export interface TelegramPort {
  /** Next message the shared bot sent into the test chat that satisfies `match`, or null on timeout. */
  waitForMessage(match: RegExp, timeoutMs: number): Promise<string | null>;
}

export interface PhonePort {
  /**
   * A scripted TTS caller dials `to` and says each line when the agent finishes speaking.
   * Returns what the agent said (as transcribed on the caller side), in order.
   */
  call(args: { to: string; callerLabel: string; script: readonly string[] }): Promise<{ callId: string; answered: boolean; agentLines: string[] }>;
}

export interface LiveEvent { type: string; payload: Record<string, unknown> }
export interface LivePort {
  /** Next realtime event on /tenants/<tid>/live of the given type (AppSync Events), or null on timeout. */
  waitForEvent(type: string, timeoutMs: number): Promise<LiveEvent | null>;
}

export interface TenantView {
  tenantId: string;
  state: string;
  /** IANA zone from the tenant profile; "tomorrow" is judged in this zone. */
  timezone: string;
  did: string | null;
  widgetKey: string | null;
  agentName: string | null;
  cardOnFile: boolean;
  factsConfirmed: boolean;
}
export interface BookingView { id: string; customerName: string; service: string; startsAt: string }
export interface CallRecord {
  callId: string;
  tenantId: string;
  transcript: Array<{ role: 'agent' | 'user'; text: string }>;
  summary: string;
  usageSeconds: number;
}

/** Read-only verification of what the platform stored. Never used to drive the flow. */
export interface PlatformPort {
  getTenant(ownerId: string): Promise<TenantView | null>;
  listBookings(tenantId: string): Promise<BookingView[]>;
  getCall(callId: string): Promise<CallRecord | null>;
}

export interface GatePorts {
  referral: ReferralPort;
  owner: OwnerPort;
  customerChat: CustomerChatPort;
  telegram: TelegramPort;
  phone: PhonePort;
  live: LivePort;
  platform: PlatformPort;
}
