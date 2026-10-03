import type { TenantInfo } from './types.js';

/**
 * Notification copy. It leads with the news and reads like a text from a colleague:
 * "New booking: Tunde, haircut, tomorrow at 3." Every line here is checked against @1145/conversation-style in tests.
 * Event data (names, messages, reasons) comes from callers and is treated as data: it is tidied, never obeyed.
 */
export interface Rendered {
  /** Telegram and email body, push body. */
  text: string;
  /** Email subject (no trailing period). */
  subject: string;
  /** Push title. */
  title: string;
  /** What the urgent call says out loud. Only set for an urgent handoff. */
  spoken?: string;
}

export interface RenderInput {
  type: string;
  data: Record<string, unknown>;
  tenant: TenantInfo;
  now: Date;
  urgent: boolean;
}


/** Control characters, zero-width and bidi override characters: never useful in a name or a message preview. */
const isInvisible = (cp: number) =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2028 || cp === 0x2029 ||
  (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;

/** Flatten to one line, drop control and bidi characters, cap the length. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let s = [...value].map((ch) => (isInvisible(ch.codePointAt(0)!) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(' ');
    if (cut > max * 0.6) s = s.slice(0, cut);
    s = s.replace(/[\s.,;:!?-]+$/, '') + '…';
  }
  return s;
}

const stripEnd = (s: string) => s.replace(/[\s.!?,;:]+$/, '');

/** Plain words only: no links, ISO dates, markdown or emoji, and a hard word cap. */
function speakable(value: unknown, maxWords: number): string {
  const s = clean(value, 400)
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/g, ' ')
    .replace(/\b(?:e\.g\.|i\.e\.|etc\.)/gi, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[*_#`~[\]<>|\\]/g, ' ')
    .replace(/…/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const w = s.split(' ').filter(Boolean);
  return stripEnd(w.slice(0, maxWords).join(' '));
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

interface Wall { y: number; m: number; d: number; h?: number; mi?: number }

function wallClock(at: Date, tz: string): Wall {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour') % 24, mi: n('minute') };
}

function parseWall(iso: string, tz: string): Wall | undefined {
  const m = WALL.exec(iso);
  if (m && !HAS_ZONE.test(iso)) {
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), ...(m[4] ? { h: Number(m[4]), mi: Number(m[5]) } : {}) };
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : wallClock(new Date(t), tz);
}

function clockPhrase(h: number, mi: number): string {
  if (h === 12 && mi === 0) return 'noon';
  if (h === 0 && mi === 0) return 'midnight';
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = mi ? `:${String(mi).padStart(2, '0')}` : '';
  // Only say am/pm when "at 3" could be misheard as the wrong half of the day.
  const suffix = h < 8 || h >= 21 ? (h < 12 ? 'am' : 'pm') : '';
  return `${hh}${mm}${suffix}`;
}

/** "tomorrow at 3", "Tuesday at 3:30", "Oct 14 at 3". Times are in the business's timezone. Empty string if unknown. */
export function whenPhrase(start: unknown, now: Date, tz: string): string {
  if (typeof start !== 'string') return '';
  let w: Wall | undefined;
  try { w = parseWall(start.trim(), tz); } catch { return ''; }
  if (!w) return '';
  const today = wallClock(now, tz);
  const diff = Math.round((Date.UTC(w.y, w.m - 1, w.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000);
  const day = diff === 0 ? 'today'
    : diff === 1 ? 'tomorrow'
    : diff === -1 ? 'yesterday'
    : diff >= 2 && diff <= 6 ? DAYS[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()]!
    : `${MONTHS[w.m - 1]} ${w.d}`;
  return w.h === undefined ? day : `${day} at ${clockPhrase(w.h, w.mi ?? 0)}`;
}

function prettyPhone(e164: unknown): string {
  const s = clean(e164, 20);
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : s;
}

const done = (text: string, title: string, extra: Partial<Rendered> = {}): Rendered => ({ text, subject: stripEnd(text), title, ...extra });

export function renderNotification(input: RenderInput): Rendered | undefined {
  const { type, data, tenant, now, urgent } = input;
  const biz = clean(tenant.name, 60) || 'your business';
  const name = clean(data.customerName ?? data.callerName, 40);
  const service = clean(data.serviceName, 60);
  const when = whenPhrase(data.start, now, tenant.timezone);

  switch (type) {
    case 'booking.created': {
      const parts = [name, service, when].filter(Boolean);
      if (name || service) return done(`New booking: ${parts.join(', ')}.`, 'New booking');
      return done(when ? `New booking for ${when}.` : 'New booking.', 'New booking');
    }
    case 'booking.cancelled': {
      if (name) return done(`${name} cancelled their ${service || 'booking'}${when ? `, ${when}` : ''}.`, 'Cancelled');
      const parts = [service, when].filter(Boolean);
      return done(parts.length ? `Cancelled: ${parts.join(', ')}.` : 'A booking was cancelled.', 'Cancelled');
    }
    case 'message.taken': {
      const label = clean(data.callerName, 40) || clean(data.callerMasked, 24);
      const msg = clean(data.message ?? data.summary, 160);
      return msg
        ? done(`Message from ${label || 'a caller'}: "${msg}"`, 'New message')
        : done(`${label || 'Someone'} left you a message.`, 'New message');
    }
    case 'handoff.requested': {
      const label = clean(data.callerName, 40) || clean(data.callerMasked, 24);
      const who = label || 'A customer';
      const reason = stripEnd(clean(data.reason, 120));
      if (!urgent) return done(`${who} asked to talk to you${reason ? `: ${reason}` : ''}.`, 'Wants to talk to you');
      const spokenWho = speakable(data.callerName, 3) || 'A caller';
      const spokenReason = speakable(data.reason, 12);
      const spoken = [
        `Hi, it's the front desk at ${speakable(biz, 4) || 'your business'}.`,
        `${spokenWho} needs you now.`,
        spokenReason ? `They said: ${spokenReason}.` : '',
        'Call them back as soon as you can.',
      ].filter(Boolean).join(' ');
      return done(`Urgent: ${who} needs you now${reason ? `, ${reason}` : ''}.`, 'Needs you now', { spoken });
    }
    case 'usage.recorded': {
      // usage.recorded fires on every call; only a threshold crossing is news.
      const threshold = Number(data.capThreshold);
      if (threshold === 100) return done("You've used up this month's minutes.", 'Out of minutes');
      if (threshold === 80) return done("You've used 80% of this month's minutes.", 'Minutes running low');
      return undefined;
    }
    case 'tenant.state_changed': {
      const state = clean(data.state, 30).toLowerCase();
      if (state === 'active') return done('Your front desk is live again.', 'Front desk update');
      if (state === 'suspended' || state === 'paused') return done('Your front desk is paused.', 'Front desk update');
      return undefined;
    }
    case 'tenant.provisioned': {
      const number = prettyPhone(data.phoneNumber);
      return done(
        number ? `You're live! Calls to ${number} now go to your front desk at ${biz}.` : `You're live! Your front desk at ${biz} is answering calls.`,
        "You're live",
      );
    }
    default:
      return undefined;
  }
}
