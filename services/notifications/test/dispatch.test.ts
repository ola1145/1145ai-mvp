import { describe, expect, it } from 'vitest';
import { dispatch, parseBusEvent, type DispatchDeps } from '../src/dispatch.js';
import type { NotifyStore, NotifyPrefs, OwnerTargets, TenantInfo, Outcome, PushSubscriptionRecord } from '../src/types.js';

const TID = 't_abcdefgh12';
const noon = new Date('2026-10-02T16:00:00Z'); // Friday 12:00 in New York
const lateNight = new Date('2026-10-03T05:30:00Z');

const sub = (n: number): PushSubscriptionRecord => ({ endpoint: `https://push.example/${n}`, p256dh: 'p', auth: 'a' });

class FakeStore implements NotifyStore {
  claims = new Set<string>();
  removed: string[] = [];
  tenant: TenantInfo = { name: 'Kemi Cuts', timezone: 'America/New_York' };
  prefs: NotifyPrefs = {};
  targets: OwnerTargets = { telegramChatIds: ['42'], emails: ['kemi@example.com'], phone: '+15552223333', pushSubscriptions: [sub(1)] };
  services: Record<string, string> = { svc1: 'haircut' };
  async getTenant() { return this.tenant; }
  async getPrefs() { return this.prefs; }
  async getTargets() { return this.targets; }
  async getServiceName(_t: string, id: string) { return this.services[id]; }
  async claim(_t: string, eventId: string, key: string) { const k = `${eventId}|${key}`; if (this.claims.has(k)) return false; this.claims.add(k); return true; }
  async release(_t: string, eventId: string, key: string) { this.claims.delete(`${eventId}|${key}`); }
  async removePushSubscription(_t: string, endpoint: string) { this.removed.push(endpoint); }
}

function setup(over: Partial<DispatchDeps> = {}, store = new FakeStore()) {
  const sent = { telegram: [] as any[], email: [] as any[], push: [] as any[], call: [] as any[] };
  const ok: Outcome = { status: 'sent', attempts: 1 };
  const deps: DispatchDeps = {
    store,
    now: () => noon,
    telegram: async (chatId, text, o) => { sent.telegram.push({ chatId, text, ...o }); return ok; },
    email: async (m) => { sent.email.push(m); return ok; },
    push: async (s, p, o) => { sent.push.push({ s, p, ...o }); return ok; },
    call: async (c) => { sent.call.push(c); return ok; },
    log: () => {},
    ...over,
  };
  return { deps, sent, store };
}

const bookingEvent = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1', 'detail-type': 'booking.created', source: '1145.tool-api',
  detail: { type: 'booking.created', version: 1, tenantId: TID, correlationId: 'corr-1', occurredAt: '2026-10-02T15:59:00Z', data: { bookingId: 'b1', serviceId: 'svc1', start: '2026-10-03T15:00', via: 'voice', customerName: 'Tunde', ...over } },
});
const handoffEvent = (data: Record<string, unknown>, id = 'evt-h1') => ({
  id, 'detail-type': 'handoff.requested', source: '1145.voice',
  detail: { type: 'handoff.requested', version: 1, tenantId: TID, correlationId: 'corr-2', occurredAt: '2026-10-02T15:59:00Z', data },
});

describe('parseBusEvent', () => {
  it('reads the envelope out of an EventBridge event', () => {
    expect(parseBusEvent(bookingEvent())).toMatchObject({ eventId: 'evt-1', type: 'booking.created', tenantId: TID });
  });
  it('rejects a bad tenant id and a missing envelope', () => {
    expect(() => parseBusEvent({ id: 'x', detail: { type: 'booking.created', tenantId: 'drop table', data: {} } })).toThrow(/tenant/i);
    expect(() => parseBusEvent({ id: 'x' })).toThrow();
  });
  it('makes a stable id when the bus did not provide one', () => {
    const e = bookingEvent(); delete (e as any).id;
    expect(parseBusEvent(e).eventId).toBe(parseBusEvent(e).eventId);
    expect(parseBusEvent(e).eventId).not.toBe('');
  });
});

describe('dispatch', () => {
  it('sends a booking to Telegram, email and push, written like a person', async () => {
    const { deps, sent } = setup();
    const report = await dispatch(bookingEvent(), deps);
    expect(sent.telegram).toEqual([{ chatId: '42', text: 'New booking: Tunde, haircut, tomorrow at 3.', silent: false }]);
    expect(sent.email).toHaveLength(1);
    expect(sent.email[0]).toMatchObject({ to: 'kemi@example.com', subject: 'New booking: Tunde, haircut, tomorrow at 3', text: 'New booking: Tunde, haircut, tomorrow at 3.' });
    expect(sent.push).toHaveLength(1);
    expect(sent.push[0].p).toMatchObject({ title: 'New booking', body: 'New booking: Tunde, haircut, tomorrow at 3.' });
    expect(sent.call).toHaveLength(0);
    expect(report.sent).toBe(3);
  });

  it('sends the channels in parallel so the owner hears fast', async () => {
    let inflight = 0; let peak = 0;
    const slow = async (): Promise<Outcome> => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 20)); inflight--; return { status: 'sent', attempts: 1 }; };
    const { deps } = setup({ telegram: slow, email: slow, push: slow });
    await dispatch(bookingEvent(), deps);
    expect(peak).toBe(3);
  });

  it('dedupes per event id, so a replayed event does not notify twice', async () => {
    const { deps, sent } = setup();
    await dispatch(bookingEvent(), deps);
    const again = await dispatch(bookingEvent(), deps);
    expect(sent.telegram).toHaveLength(1);
    expect(sent.email).toHaveLength(1);
    expect(sent.push).toHaveLength(1);
    expect(again.sent).toBe(0);
    expect(again.duplicates).toBe(3);
    // a different event id goes through
    await dispatch({ ...bookingEvent(), id: 'evt-2' }, deps);
    expect(sent.telegram).toHaveLength(2);
  });

  it('on a retryable failure, releases the claim and throws so the bus redelivers, resending only what failed', async () => {
    let emailUp = false;
    const { deps, sent } = setup({ email: async (m) => { if (!emailUp) return { status: 'failed', attempts: 3, detail: 'resend 503' }; sent.email.push(m); return { status: 'sent', attempts: 1 }; } });
    await expect(dispatch(bookingEvent(), deps)).rejects.toThrow(/email/);
    expect(sent.telegram).toHaveLength(1);
    emailUp = true;
    const r = await dispatch(bookingEvent(), deps);
    expect(sent.telegram).toHaveLength(1); // not again
    expect(sent.email).toHaveLength(1);
    expect(r.sent).toBe(1);
  });

  it('a rejected target (blocked bot, bad address) does not make the bus redeliver', async () => {
    const { deps } = setup({ telegram: async () => ({ status: 'rejected', attempts: 1, detail: 'blocked' }) });
    const r = await dispatch(bookingEvent(), deps);
    expect(r.rejected).toBe(1);
    expect(r.sent).toBe(2);
  });

  it('removes expired push subscriptions', async () => {
    const store = new FakeStore();
    store.targets.pushSubscriptions = [sub(1), sub(2)];
    const { deps } = setup({ push: async (s) => (s.endpoint.endsWith('/2') ? { status: 'gone', attempts: 1 } : { status: 'sent', attempts: 1 }) }, store);
    await dispatch(bookingEvent(), deps);
    expect(store.removed).toEqual(['https://push.example/2']);
  });

  it('only uses channels the owner actually has', async () => {
    const store = new FakeStore();
    store.targets = { telegramChatIds: [], emails: ['kemi@example.com'], pushSubscriptions: [] };
    const { deps, sent } = setup({}, store);
    await dispatch(bookingEvent(), deps);
    expect(sent.telegram).toHaveLength(0);
    expect(sent.push).toHaveLength(0);
    expect(sent.email).toHaveLength(1);
  });

  it('follows the owner preferences for this event type', async () => {
    const store = new FakeStore();
    store.prefs = { events: { 'booking.created': ['telegram'] } };
    const { deps, sent } = setup({}, store);
    await dispatch(bookingEvent(), deps);
    expect(sent.telegram).toHaveLength(1);
    expect(sent.email).toHaveLength(0);
    expect(sent.push).toHaveLength(0);
  });

  it('respects quiet hours: silent Telegram, no push, email still lands', async () => {
    const store = new FakeStore();
    store.prefs = { quietHours: { start: '22:00', end: '07:00' } };
    const { deps, sent } = setup({ now: () => lateNight }, store);
    await dispatch(bookingEvent(), deps);
    expect(sent.telegram[0].silent).toBe(true);
    expect(sent.push).toHaveLength(0);
    expect(sent.email).toHaveLength(1);
  });

  it('looks up the service name when the event only has an id', async () => {
    const { deps, sent } = setup();
    await dispatch(bookingEvent({ customerName: undefined }), deps);
    expect(sent.telegram[0].text).toBe('New booking: haircut, tomorrow at 3.');
  });

  it('ignores event types that are not owner news, and usage without a threshold', async () => {
    const { deps, sent } = setup();
    const r1 = await dispatch({ id: 'x', detail: { type: 'call.ended', version: 1, tenantId: TID, correlationId: 'c', occurredAt: '2026-10-02T15:00:00Z', data: {} } }, deps);
    const r2 = await dispatch({ id: 'y', detail: { type: 'usage.recorded', version: 1, tenantId: TID, correlationId: 'c', occurredAt: '2026-10-02T15:00:00Z', data: { callId: 'c', billableSeconds: 5, engine: 'x' } } }, deps);
    expect(r1.sent + r2.sent).toBe(0);
    expect(sent.telegram).toHaveLength(0);
  });
});

describe('urgent handoff call', () => {
  it('calls the owner only for an urgent handoff, with a spoken line', async () => {
    const { deps, sent } = setup();
    await dispatch(handoffEvent({ callerName: 'Tunde', reason: 'water coming through the ceiling', urgent: true }), deps);
    expect(sent.call).toHaveLength(1);
    expect(sent.call[0].to).toBe('+15552223333');
    expect(sent.call[0].spoken).toContain('Tunde needs you now');
    expect(sent.telegram[0].text).toBe('Urgent: Tunde needs you now, water coming through the ceiling.');
  });

  it('does not call for a normal handoff', async () => {
    const { deps, sent } = setup();
    await dispatch(handoffEvent({ callerName: 'Tunde', reason: 'wants a quote' }), deps);
    expect(sent.call).toHaveLength(0);
    expect(sent.telegram).toHaveLength(1);
  });

  it('never calls for other event types, even if the data says urgent', async () => {
    const { deps, sent } = setup();
    await dispatch(bookingEvent({ urgent: true }), deps);
    await dispatch({ ...handoffEvent({ urgent: true }), 'detail-type': 'message.taken', detail: { ...handoffEvent({ urgent: true }).detail, type: 'message.taken' }, id: 'm1' }, deps);
    expect(sent.call).toHaveLength(0);
  });

  it('does not call when the owner has no phone on file, and does not fall back to SMS', async () => {
    const store = new FakeStore();
    store.targets = { ...store.targets, phone: undefined };
    const { deps, sent } = setup({}, store);
    await dispatch(handoffEvent({ callerName: 'Tunde', urgent: true }), deps);
    expect(sent.call).toHaveLength(0);
    expect(sent.telegram).toHaveLength(1);
  });

  it('does not ring twice when the event is replayed', async () => {
    const { deps, sent } = setup();
    await dispatch(handoffEvent({ callerName: 'Tunde', urgent: true }), deps);
    await dispatch(handoffEvent({ callerName: 'Tunde', urgent: true }), deps);
    expect(sent.call).toHaveLength(1);
  });

  it('still sends the text channels at night, and honours "no night calls"', async () => {
    const store = new FakeStore();
    store.prefs = { quietHours: { start: '22:00', end: '07:00' }, urgentCallInQuietHours: false };
    const { deps, sent } = setup({ now: () => lateNight }, store);
    await dispatch(handoffEvent({ callerName: 'Tunde', urgent: true }), deps);
    expect(sent.call).toHaveLength(0);
    expect(sent.telegram[0].silent).toBe(false);
  });

  it('reads urgency from data.urgent === true or data.urgency === "urgent" only', async () => {
    const { deps, sent } = setup();
    await dispatch(handoffEvent({ urgency: 'urgent' }, 'h2'), deps);
    await dispatch(handoffEvent({ urgent: 'yes please' }, 'h3'), deps);
    await dispatch(handoffEvent({ urgency: 'normal' }, 'h4'), deps);
    expect(sent.call).toHaveLength(1);
  });
});
