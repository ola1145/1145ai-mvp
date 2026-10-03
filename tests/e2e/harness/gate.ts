/**
 * The Gate scenario from docs/03-implementation-plan.md:
 *   friend link -> owner web chat -> sign-in -> basics -> card on file -> number bought -> facts confirmed -> agent named
 *   -> smoke call answered -> second phone calls the DID and books -> owner gets a Telegram notification and sees it live
 *   -> owner asks the copilot "what's booked tomorrow?" -> transcript, summary, usage recorded
 *   -> style checks pass on every agent turn.
 *
 * runGate() is adapter-agnostic: it works against the fake (tests) and against the deployed dev stack (live.ts).
 */
import type { BookingView, GatePorts, Turn } from './ports.ts';
import { checkCapturedTurns, type StyleReport } from './style.ts';
import { isTomorrow } from './time.ts';

export const GATE_STEP_IDS = [
  'friend-link',
  'owner-signs-in',
  'basics',
  'card-on-file',
  'number-bought',
  'facts-confirmed',
  'agent-named',
  'smoke-call-answered',
  'customer-web-chat',
  'customer-call-books',
  'owner-telegram-notified',
  'owner-sees-it-live',
  'copilot-answers',
  'call-recorded',
] as const;
export type GateStepId = (typeof GATE_STEP_IDS)[number];

export interface StepResult { id: GateStepId; status: 'pass' | 'fail' | 'skipped'; detail?: string; ms: number }
export interface GateReport { ok: boolean; steps: StepResult[]; turns: Turn[]; style: StyleReport; startedAt: string }

export interface GateOptions {
  now?: Date;
  referralCode?: string;
  timeouts?: { eventMs?: number; telegramMs?: number; provisionMs?: number; pollMs?: number };
}

/** What the scripted humans say. Plain speech, the way people actually type and talk. */
export const SCRIPT = {
  owner: {
    hello: 'hi, a friend sent me',
    businessName: 'Kemi Cuts',
    basics: 'Barbershop. Open Tuesday to Saturday, 9 to 6. A haircut is 30 dollars.',
    cardAdded: "ok, I added my card",
    factsOk: 'yep, that all looks right',
    agentName: 'Ava',
    copilot: "what's booked tomorrow?",
  },
  smokeCall: ["Hey, just testing. Can you hear me?", 'Great, thanks.'],
  customerChat: ['What are your hours?'],
  customerCall: ["Hi, I'd like a haircut tomorrow at three.", "It's Tunde.", "Yep, that's right.", 'Thanks, bye.'],
  customerName: 'Tunde',
} as const;

const E164 = /^\+1\d{10}$/;
// Realtime payloads must carry masked numbers (+1••••••1234), never raw ones. contracts/realtime/channels.md
const RAW_PHONE = /\+\d{10,15}|\(\d{3}\)\s?\d{3}[-\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;

class StepFailure extends Error {}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new StepFailure(msg); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T | null | undefined | false>, timeoutMs: number, pollMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v) return v as T;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

export async function runGate(ports: GatePorts, opts: GateOptions = {}): Promise<GateReport> {
  const now = opts.now ?? new Date();
  const referralCode = opts.referralCode ?? 'gate_friend_01';
  const to = { event: opts.timeouts?.eventMs ?? 15_000, telegram: opts.timeouts?.telegramMs ?? 30_000, provision: opts.timeouts?.provisionMs ?? 120_000, poll: opts.timeouts?.pollMs ?? 2_000 };

  const turns: Turn[] = [];
  const say = (surface: Turn['surface'], conversationId: string, user: string, agent: readonly string[]) => {
    turns.push({ surface, conversationId, role: 'user', text: user });
    for (const a of agent) turns.push({ surface, conversationId, role: 'agent', text: a });
  };
  const hear = (surface: Turn['surface'], conversationId: string, agent: readonly string[]) => {
    for (const a of agent) turns.push({ surface, conversationId, role: 'agent', text: a });
  };
  const asCall = (conversationId: string, script: readonly string[], agentLines: readonly string[]) => {
    agentLines.forEach((line, i) => {
      turns.push({ surface: 'phone', conversationId, role: 'agent', text: line });
      if (script[i] !== undefined) turns.push({ surface: 'phone', conversationId, role: 'user', text: script[i]! });
    });
  };

  let ownerId = '';
  let tenantId = '';
  let did = '';
  let customerCallId = '';
  let booking: BookingView | undefined;

  const tenant = async () => {
    const t = await ports.platform.getTenant(ownerId);
    must(t, 'no tenant exists for the signed-in owner');
    tenantId = t.tenantId;
    return t;
  };

  const steps: Record<GateStepId, () => Promise<string | void>> = {
    'friend-link': async () => {
      const r = await ports.referral.follow(referralCode);
      must(r.status === 302, `referral link answered ${r.status}, expected a 302 redirect`);
      must(r.location.includes(referralCode), `redirect ${r.location} lost the referral code`);
    },
    'owner-signs-in': async () => {
      ({ ownerId } = await ports.owner.signIn());
      must(ownerId, 'sign-in returned no owner id');
    },
    basics: async () => {
      const a = await ports.owner.send(SCRIPT.owner.hello, { referralCode });
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.hello, a);
      must(a.length > 0, 'owner chat did not answer the first message');
      const b = await ports.owner.send(SCRIPT.owner.businessName);
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.businessName, b);
      const c = await ports.owner.send(SCRIPT.owner.basics);
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.basics, c);
      must(b.length > 0 && c.length > 0, 'owner chat went quiet during basics');
      await tenant();
    },
    'card-on-file': async () => {
      await ports.owner.addTestCard();
      const a = await ports.owner.send(SCRIPT.owner.cardAdded);
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.cardAdded, a);
      const t = await tenant();
      must(t.cardOnFile, 'card is not on file after the test card was added');
    },
    'number-bought': async () => {
      const t = await until(async () => { const x = await tenant(); return x.did ? x : null; }, to.provision, to.poll);
      must(t, `no phone number was bought within ${to.provision} ms`);
      must(E164.test(t.did!), `number ${t.did} is not a US E.164 number`);
      did = t.did!;
    },
    'facts-confirmed': async () => {
      const a = await ports.owner.send(SCRIPT.owner.factsOk);
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.factsOk, a);
      const t = await tenant();
      must(t.factsConfirmed, 'facts are not marked confirmed after the owner said yes');
    },
    'agent-named': async () => {
      const a = await ports.owner.send(SCRIPT.owner.agentName);
      say('owner-chat', 'owner-onboarding', SCRIPT.owner.agentName, a);
      const t = await tenant();
      must(t.agentName === SCRIPT.owner.agentName, `agent name is ${JSON.stringify(t.agentName)}, expected ${SCRIPT.owner.agentName}`);
    },
    'smoke-call-answered': async () => {
      const r = await ports.phone.call({ to: did, callerLabel: 'owner-smoke', script: SCRIPT.smokeCall });
      must(r.answered, `smoke call to ${did} was not answered`);
      asCall('call-smoke', SCRIPT.smokeCall, r.agentLines);
      const rec = await ports.platform.getCall(r.callId);
      must(rec, 'smoke call was answered but no call record exists');
      must(rec.tenantId === tenantId, 'smoke call was recorded under another tenant');
    },
    'customer-web-chat': async () => {
      const t = await tenant();
      must(t.widgetKey, 'tenant has no widget key');
      const opened = await ports.customerChat.open(t.widgetKey);
      must(opened.greeting, 'web chat opened with no greeting');
      hear('customer-chat', 'customer-webchat', [opened.greeting]);
      for (const line of SCRIPT.customerChat) {
        const a = await ports.customerChat.send(line);
        say('customer-chat', 'customer-webchat', line, a);
        must(a.length > 0, `web chat did not answer "${line}"`);
      }
    },
    'customer-call-books': async () => {
      const r = await ports.phone.call({ to: did, callerLabel: 'second-phone', script: SCRIPT.customerCall });
      must(r.answered, `second phone call to ${did} was not answered`);
      asCall('call-booking', SCRIPT.customerCall, r.agentLines);
      customerCallId = r.callId;
      const t = await tenant();
      const rec = await ports.platform.getCall(customerCallId);
      must(rec, 'booking call has no call record');
      must(rec.tenantId === t.tenantId, 'the call was recorded under a different tenant than the number owner (tenant must come from the dialed number)');
      const all = await ports.platform.listBookings(t.tenantId);
      booking = all.find((b) => b.customerName.toLowerCase() === SCRIPT.customerName.toLowerCase());
      must(booking, `no booking for ${SCRIPT.customerName} after the call`);
      must(isTomorrow(booking.startsAt, now, t.timezone), `booking ${booking.startsAt} is not tomorrow in ${t.timezone}`);
      must(/haircut/i.test(booking.service), `booking service is ${JSON.stringify(booking.service)}, expected a haircut`);
    },
    'owner-telegram-notified': async () => {
      const m = await ports.telegram.waitForMessage(new RegExp(SCRIPT.customerName, 'i'), to.telegram);
      must(m, `no Telegram message about ${SCRIPT.customerName} within ${to.telegram} ms`);
      hear('telegram', 'owner-telegram', [m]);
    },
    'owner-sees-it-live': async () => {
      const e = await ports.live.waitForEvent('booking.created', to.event);
      must(e, `no booking.created realtime event within ${to.event} ms`);
      must(!RAW_PHONE.test(JSON.stringify(e.payload)), 'realtime payload contains an unmasked phone number');
    },
    'copilot-answers': async () => {
      const a = await ports.owner.send(SCRIPT.owner.copilot);
      say('owner-chat', 'owner-copilot', SCRIPT.owner.copilot, a);
      const text = a.join(' ');
      must(new RegExp(SCRIPT.customerName, 'i').test(text), `copilot answer does not mention ${SCRIPT.customerName}: "${text}"`);
      must(/\b(3|three)\b/i.test(text), `copilot answer does not give the time: "${text}"`);
    },
    'call-recorded': async () => {
      const rec = await ports.platform.getCall(customerCallId);
      must(rec, 'no call record');
      must(rec.transcript.length >= 4, `transcript has ${rec.transcript.length} turns`);
      must(rec.transcript.some((t) => t.role === 'agent') && rec.transcript.some((t) => t.role === 'user'), 'transcript is missing one side of the call');
      must(rec.summary.trim().length > 0, 'call summary is empty');
      must(rec.usageSeconds > 0, 'no usage was recorded for the call');
    },
  };

  const results: StepResult[] = [];
  let broken = false;
  for (const id of GATE_STEP_IDS) {
    if (broken) { results.push({ id, status: 'skipped', ms: 0 }); continue; }
    const t0 = Date.now();
    try {
      const detail = await steps[id]();
      results.push({ id, status: 'pass', ms: Date.now() - t0, ...(detail ? { detail } : {}) });
    } catch (err) {
      broken = true;
      results.push({ id, status: 'fail', detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
    }
  }

  // Style runs on whatever was captured, even when a step broke, so a robotic reply is never hidden behind another failure.
  const style = checkCapturedTurns(turns);
  return { ok: !broken && style.ok, steps: results, turns, style, startedAt: now.toISOString() };
}
