/** Shared shapes for owner notifications (owner: C6). No SMS and no WhatsApp: ADR-0005. */

export const NOTIFY_EVENT_TYPES = [
  'booking.created', 'booking.cancelled', 'message.taken', 'handoff.requested',
  'usage.recorded', 'tenant.state_changed', 'tenant.provisioned',
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

/** Channels an owner can pick per event type. The urgent call is separate: it is never a preference, only a rule. */
export type OwnerChannel = 'telegram' | 'email' | 'push';

export interface QuietHours { start: string; end: string } // "HH:MM" in the tenant timezone

export interface NotifyPrefs {
  /** Per event type; a missing key means "use the default", an empty list means "not for this one". */
  events?: Partial<Record<NotifyEventType, OwnerChannel[]>>;
  quietHours?: QuietHours | null;
  /** Ring the owner for an urgent handoff. Default true. */
  urgentCall?: boolean;
  /** Ring even during quiet hours. Default true (it is urgent). */
  urgentCallInQuietHours?: boolean;
}

export interface PushSubscriptionRecord { endpoint: string; p256dh: string; auth: string }

export interface OwnerTargets {
  telegramChatIds: string[];
  emails: string[];
  /** E.164, used only for the urgent call. */
  phone?: string;
  pushSubscriptions: PushSubscriptionRecord[];
}

export interface TenantInfo { name: string; timezone: string }

/** What an adapter tells the dispatcher. `failed` is retryable (the bus should redeliver); the rest are final. */
export type Outcome =
  | { status: 'sent'; attempts: number }
  | { status: 'rejected'; attempts: number; detail?: string }
  | { status: 'gone'; attempts: number; detail?: string }
  | { status: 'failed'; attempts: number; detail?: string }
  | { status: 'skipped'; attempts: number; detail?: string };

export interface NotifyStore {
  getTenant(tenantId: string): Promise<TenantInfo>;
  getPrefs(tenantId: string): Promise<NotifyPrefs>;
  getTargets(tenantId: string): Promise<OwnerTargets>;
  getServiceName(tenantId: string, serviceId: string): Promise<string | undefined>;
  /** True if this event+channel+target was not claimed before (so it is ours to send). */
  claim(tenantId: string, eventId: string, key: string): Promise<boolean>;
  release(tenantId: string, eventId: string, key: string): Promise<void>;
  removePushSubscription(tenantId: string, endpoint: string): Promise<void>;
}

export interface PushPayload { title: string; body: string; tag?: string; url?: string; type?: string }
