import type { NotifyEventType, NotifyPrefs, OwnerChannel, QuietHours } from './types.js';

/** Where each kind of news goes when the owner has not chosen. */
export const DEFAULT_ROUTES: Record<NotifyEventType, OwnerChannel[]> = {
  'booking.created': ['telegram', 'email', 'push'],
  'booking.cancelled': ['telegram', 'email', 'push'],
  'message.taken': ['telegram', 'push', 'email'],
  'handoff.requested': ['telegram', 'push', 'email'],
  'usage.recorded': ['telegram', 'email'],
  'tenant.state_changed': ['telegram', 'email'],
  'tenant.provisioned': ['telegram', 'email'],
};

export interface DeliveryPlan {
  /** null = do not send to Telegram. `silent` delivers without a buzz. */
  telegram: { silent: boolean } | null;
  email: boolean;
  push: boolean;
  /** The urgent phone call. Only ever true for an urgent handoff.requested. */
  call: boolean;
  quiet: boolean;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (s: string): number | undefined => {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** Minutes since local midnight in `timezone`. */
export function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

export function isQuietNow(at: Date, timezone: string, quiet: QuietHours | null | undefined): boolean {
  if (!quiet) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === undefined || end === undefined || start === end) return false;
  const now = localMinutes(at, timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Decide who to tell and how loudly. Pure, so it is easy to test.
 * The urgent call is the only thing that ever rings a phone: it needs an urgent handoff.requested and nothing else.
 */
export function planDelivery(type: NotifyEventType, prefs: NotifyPrefs, at: Date, timezone: string, urgent: boolean): DeliveryPlan {
  const base = DEFAULT_ROUTES[type];
  if (!base) return { telegram: null, email: false, push: false, call: false, quiet: false };
  const chosen = prefs.events?.[type] ?? base;
  const quiet = isQuietNow(at, timezone, prefs.quietHours);
  const isUrgentHandoff = type === 'handoff.requested' && urgent;
  // Urgent news is never muted; everything else goes quiet at night.
  const hush = quiet && !isUrgentHandoff;
  const call = isUrgentHandoff && prefs.urgentCall !== false && (!quiet || prefs.urgentCallInQuietHours !== false);
  return {
    telegram: chosen.includes('telegram') ? { silent: hush } : null,
    email: chosen.includes('email'),
    push: chosen.includes('push') && !hush,
    call,
    quiet,
  };
}
