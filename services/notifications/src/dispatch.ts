import { createHash } from 'node:crypto';
import { asTenantId } from '@1145/shared';
import type { CallPlacer } from './adapters/telnyx-call.js';
import type { EmailSender } from './adapters/resend.js';
import type { PushSender } from './adapters/webpush.js';
import type { TelegramSender } from './adapters/telegram.js';
import { planDelivery } from './routing.js';
import { renderNotification } from './templates.js';
import { NOTIFY_EVENT_TYPES, type NotifyEventType, type NotifyStore, type Outcome } from './types.js';

export interface DispatchDeps {
  store: NotifyStore;
  now: () => Date;
  telegram: TelegramSender;
  email: EmailSender;
  push: PushSender;
  call: CallPlacer;
  /** Structured log line. Never put message text, names or numbers in it. */
  log: (line: Record<string, unknown>) => void;
}

export interface DispatchReport { sent: number; rejected: number; duplicates: number; failed: number; skipped: number }

export interface ParsedEvent {
  eventId: string;
  type: string;
  tenantId: string;
  correlationId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read an EventBridge event. The tenant comes from the envelope the platform services publish on the bus
 * (contracts/events), never from anything inside `data`.
 */
export function parseBusEvent(raw: unknown): ParsedEvent {
  if (!isObj(raw) || !isObj(raw.detail)) throw new Error('not an event bus message');
  const d = raw.detail;
  const type = typeof d.type === 'string' ? d.type : typeof raw['detail-type'] === 'string' ? (raw['detail-type'] as string) : '';
  const tenantId = asTenantId(typeof d.tenantId === 'string' ? d.tenantId : '');
  const data = isObj(d.data) ? d.data : {};
  const correlationId = typeof d.correlationId === 'string' ? d.correlationId : '';
  const occurredAt = typeof d.occurredAt === 'string' ? d.occurredAt : '';
  const eventId = typeof raw.id === 'string' && raw.id
    ? raw.id
    : createHash('sha256').update(`${type}|${tenantId}|${correlationId}|${occurredAt}|${JSON.stringify(data)}`).digest('hex').slice(0, 24);
  return { eventId, type, tenantId, correlationId, occurredAt, data };
}

const isUrgent = (type: string, data: Record<string, unknown>) =>
  type === 'handoff.requested' && (data.urgent === true || data.urgency === 'urgent');

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

interface Task { channel: 'telegram' | 'email' | 'push' | 'call'; key: string; run: () => Promise<Outcome>; onGone?: () => Promise<void> }

/** Turn one bus event into owner notifications. Throws only when a retryable delivery failed, so the bus redelivers. */
export async function dispatch(raw: unknown, deps: DispatchDeps): Promise<DispatchReport> {
  const report: DispatchReport = { sent: 0, rejected: 0, duplicates: 0, failed: 0, skipped: 0 };
  const ev = parseBusEvent(raw);
  if (!(NOTIFY_EVENT_TYPES as readonly string[]).includes(ev.type)) return report;
  const type = ev.type as NotifyEventType;
  const { store, now } = deps;
  const urgent = isUrgent(type, ev.data);

  const [tenant, prefs, targets] = await Promise.all([store.getTenant(ev.tenantId), store.getPrefs(ev.tenantId), store.getTargets(ev.tenantId)]);
  let data = ev.data;
  if ((type === 'booking.created' || type === 'booking.cancelled') && !data.serviceName && typeof data.serviceId === 'string') {
    const serviceName = await store.getServiceName(ev.tenantId, data.serviceId);
    if (serviceName) data = { ...data, serviceName };
  }

  const rendered = renderNotification({ type, data, tenant, now: now(), urgent });
  if (!rendered) return report;
  const plan = planDelivery(type, prefs, now(), tenant.timezone, urgent);

  const tasks: Task[] = [];
  if (plan.telegram) {
    const { silent } = plan.telegram;
    for (const chatId of targets.telegramChatIds) tasks.push({ channel: 'telegram', key: `telegram:${chatId}`, run: () => deps.telegram(chatId, rendered.text, { silent }) });
  }
  if (plan.email) {
    for (const to of targets.emails) {
      tasks.push({ channel: 'email', key: `email:${to}`, run: () => deps.email({ to, subject: rendered.subject, text: rendered.text, idempotencyKey: `${ev.eventId}-${short(to)}` }) });
    }
  }
  if (plan.push) {
    const payload = { title: rendered.title, body: rendered.text, tag: ev.eventId.slice(0, 64), type, url: '/' };
    for (const sub of targets.pushSubscriptions) {
      tasks.push({
        channel: 'push', key: `push:${sub.endpoint}`,
        run: () => deps.push(sub, payload, { urgent }),
        onGone: () => store.removePushSubscription(ev.tenantId, sub.endpoint),
      });
    }
  }
  // The only phone call there is: an urgent handoff, to the owner's own number, with a line to say.
  if (plan.call && type === 'handoff.requested' && urgent && rendered.spoken && targets.phone) {
    const to = targets.phone;
    const spoken = rendered.spoken;
    tasks.push({ channel: 'call', key: `call:${to}`, run: () => deps.call({ to, spoken, idempotencyKey: ev.eventId }) });
  }

  const failedChannels = new Set<string>();
  await Promise.all(tasks.map(async (t) => {
    try {
      if (!(await store.claim(ev.tenantId, ev.eventId, t.key))) { report.duplicates++; return; }
    } catch {
      report.failed++; failedChannels.add(t.channel); return;
    }
    let outcome: Outcome;
    try { outcome = await t.run(); } catch (e) { outcome = { status: 'failed', attempts: 1, detail: e instanceof Error ? e.message : 'send threw' }; }
    switch (outcome.status) {
      case 'sent': report.sent++; break;
      case 'gone':
        report.rejected++;
        await t.onGone?.().catch(() => undefined);
        break;
      case 'rejected': report.rejected++; break;
      case 'skipped': report.skipped++; break;
      case 'failed':
        report.failed++; failedChannels.add(t.channel);
        // Free the claim so the redelivery tries this one again (and only this one).
        await store.release(ev.tenantId, ev.eventId, t.key).catch(() => undefined);
        break;
    }
    deps.log({ msg: 'notify', tenantId: ev.tenantId, type, eventId: ev.eventId, channel: t.channel, status: outcome.status, attempts: outcome.attempts, detail: outcome.status === 'sent' ? undefined : outcome.detail });
  }));

  if (failedChannels.size) throw new Error(`notification delivery failed for ${[...failedChannels].join(', ')}`);
  return report;
}
