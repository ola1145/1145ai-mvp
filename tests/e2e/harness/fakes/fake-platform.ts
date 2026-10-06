/**
 * In-memory stand-in for the deployed dev stack. It implements every port in ../ports.ts with the behavior the
 * real product is supposed to have (human replies, tenant resolved from the dialed number, masked realtime
 * payloads, booking + notification + recorded call), plus switchable faults so the harness can prove it
 * actually catches a broken flow. No network, no AWS, no Telnyx, no Telegram.
 */
import type { BookingView, CallRecord, GatePorts, LiveEvent, TenantView } from '../ports.ts';
import { localDate, nextDate, zonedToIso } from '../time.ts';

export type Fault =
  | 'robotic-greeting'
  | 'robotic-notification'
  | 'no-disclosure'
  | 'no-booking'
  | 'no-telegram'
  | 'number-never-bought'
  | 'wrong-tenant'
  | 'unmasked-phone-in-live-event'
  | 'no-usage';

export interface FakeOptions { fault?: Fault; now?: Date }

const TZ = 'America/Chicago';
const OWNER_ID = 'owner-fake-1';
const FAKE_DID = '+12145550142';

export function createFakePlatform(opts: FakeOptions = {}) {
  const now = opts.now ?? new Date();
  const fault = opts.fault;
  const state: {
    tenant: TenantView | null;
    stage: 'new' | 'name' | 'basics' | 'card' | 'facts' | 'agent-name' | 'active';
    bookings: BookingView[];
    calls: Map<string, CallRecord>;
    telegram: string[];
    events: LiveEvent[];
    referrals: string[];
    httpLog: string[];
  } = { tenant: null, stage: 'new', bookings: [], calls: new Map(), telegram: [], events: [], referrals: [], httpLog: [] };

  let callSeq = 0;
  const tenantOrThrow = () => { if (!state.tenant) throw new Error('fake: tenant does not exist yet'); return state.tenant; };

  const greeting = () => {
    const name = state.tenant?.agentName ?? 'Ava';
    if (fault === 'robotic-greeting') return 'Thank you for calling Kemi Cuts. Your call is important to us. How may I assist you today?';
    if (fault === 'no-disclosure') return `Hi, this is ${name} at Kemi Cuts. What can I do for you?`;
    return `Hi, this is ${name} at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?`;
  };

  const ports: GatePorts = {
    referral: {
      async follow(code) {
        state.referrals.push(code);
        return { status: 302, location: `https://app.1145.ai/start?ref=${code}` };
      },
    },

    owner: {
      async signIn() { return { ownerId: OWNER_ID }; },
      async addTestCard() { tenantOrThrow().cardOnFile = true; },
      async send(text) {
        if (state.stage === 'new') {
          state.stage = 'name';
          return ["Hey, welcome! What's your business called?"];
        }
        if (state.stage === 'name') {
          state.tenant = { tenantId: 'tnt_fake_1', state: 'ONBOARDING', timezone: TZ, did: null, widgetKey: 'wk_fakefakefakefake1234', agentName: null, cardOnFile: false, factsConfirmed: false };
          state.stage = 'basics';
          return ['Nice, Kemi Cuts. What kind of business is it, and when are you open?'];
        }
        if (state.stage === 'basics') {
          state.stage = 'card';
          return ["Barbers are a great fit. Add a card when you're ready and I'll grab your number."];
        }
        if (state.stage === 'card') {
          const t = tenantOrThrow();
          if (!t.cardOnFile) return ["I don't see a card yet. Can you add one?"];
          if (fault !== 'number-never-bought') t.did = FAKE_DID;
          state.stage = 'facts';
          return ["Got it, grabbing your number now. Does this look right: barbershop, Tuesday to Saturday, nine to six, haircut thirty dollars?"];
        }
        if (state.stage === 'facts') {
          tenantOrThrow().factsConfirmed = true;
          state.stage = 'agent-name';
          return ['Perfect. What should I call your receptionist?'];
        }
        if (state.stage === 'agent-name') {
          tenantOrThrow().agentName = text.trim();
          state.stage = 'active';
          return [`${text.trim()} it is. Give your number a ring and she'll pick up.`];
        }
        // copilot
        const t = tenantOrThrow();
        const tomorrow = nextDate(localDate(now, t.timezone));
        const todays = state.bookings.filter((b) => localDate(new Date(b.startsAt), t.timezone) === tomorrow);
        if (!todays.length) return ['Nothing tomorrow yet.'];
        return [`${todays.length === 1 ? 'One' : String(todays.length)} tomorrow: ${todays.map((b) => `${b.customerName} at 3, ${b.service}`).join(', ')}.`];
      },
    },

    customerChat: {
      async open(widgetKey) {
        state.httpLog.push(`webchat/token widgetKey=${widgetKey}`);
        const t = tenantOrThrow();
        if (widgetKey !== t.widgetKey) throw new Error('unknown widget');
        return { agentName: t.agentName ?? 'Ava', greeting: `Hi, this is ${t.agentName ?? 'Ava'} at Kemi Cuts. Ask me anything, or I can book you in.` };
      },
      async send() { return ["We're open Tuesday to Saturday, nine to six."]; },
    },

    telegram: {
      async waitForMessage(match) { return state.telegram.find((m) => match.test(m)) ?? null; },
    },

    phone: {
      async call({ to, callerLabel, script }) {
        const t = state.tenant;
        // Tenant is resolved from the dialed number only.
        if (!t || to !== t.did) return { callId: '', answered: false, agentLines: [] };
        const callId = `call_fake_${++callSeq}`;
        const booking = callerLabel === 'second-phone';
        const agentLines = [greeting()];
        if (booking) {
          agentLines.push('Tomorrow at three works. Can I get your name?', 'Thanks Tunde. Haircut tomorrow at three, right?', "Perfect, you're all set. See you tomorrow!", 'Take care!');
        } else {
          agentLines.push("Loud and clear! You're all set up.", 'Anytime!');
        }
        const lines = agentLines.slice(0, script.length + 1);
        const transcript: CallRecord['transcript'] = [];
        lines.forEach((a, i) => { transcript.push({ role: 'agent', text: a }); if (script[i] !== undefined) transcript.push({ role: 'user', text: script[i]! }); });
        const recordedTenant = booking && fault === 'wrong-tenant' ? 'tnt_someone_else' : t.tenantId;
        state.calls.set(callId, { callId, tenantId: recordedTenant, transcript, summary: booking ? 'Tunde booked a haircut for tomorrow at three.' : 'Owner test call.', usageSeconds: fault === 'no-usage' ? 0 : 42 });
        if (booking && fault !== 'no-booking') {
          const day = nextDate(localDate(now, t.timezone));
          state.bookings.push({ id: 'bk_fake_1', customerName: 'Tunde', service: 'haircut', startsAt: zonedToIso(day, 15, 0, t.timezone) });
          if (fault !== 'no-telegram') {
            state.telegram.push(fault === 'robotic-notification'
              ? 'Please be advised that a booking has been created for valued customer Tunde. Kindly review at your earliest convenience.'
              : 'New booking: Tunde, haircut, tomorrow at 3.');
          }
          state.events.push({ type: 'booking.created', payload: { bookingId: 'bk_fake_1', customerName: 'Tunde', callerPhone: fault === 'unmasked-phone-in-live-event' ? '+12145550199' : '+1••••••0199' } });
        }
        return { callId, answered: true, agentLines: lines };
      },
    },

    live: {
      async waitForEvent(type) { return state.events.find((e) => e.type === type) ?? null; },
    },

    platform: {
      async getTenant(ownerId) { return ownerId === OWNER_ID && state.tenant ? { ...state.tenant } : null; },
      async listBookings(tenantId) { return state.tenant?.tenantId === tenantId ? [...state.bookings] : []; },
      async getCall(callId) { return state.calls.get(callId) ?? null; },
    },
  };

  return { ports, state };
}
