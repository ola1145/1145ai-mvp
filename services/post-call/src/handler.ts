/**
 * call.ended -> usage, Stripe usage, analysis, customer record, live events. Owner: issue G3 (tasks/G3.md).
 *
 * EventBridge delivers at least once and retries failures, so the same call.ended can arrive many times, sometimes
 * at once, and a run can die half way through. Two rules keep that safe:
 *
 *  1. Work is split into steps. Each finished step is written to a per-call ledger (POSTCALL#<callId>) together with
 *     what later steps need, so a retry starts at the step that failed instead of from the top. A replay of a
 *     finished call finds every step done and does nothing.
 *  2. One invocation at a time works on a call (a lease on that ledger item). A concurrent duplicate steps aside;
 *     if the holder dies, the lease runs out and the next retry takes over.
 *
 * Steps are independent where they can be: a Stripe outage does not hold back the customer record or the live
 * event. When any step fails the handler still finishes the others and then throws, so Lambda retries the event.
 *
 * Tenant, call and channel come from the call.ended envelope on the bus (checked in deps.ts), never from the
 * transcript or the model's reply. The transcript is caller-controlled text and only ever reaches the model as data.
 */
import { makeEvent, type CallEndedData, type EventEnvelope } from '@1145/shared';
import type { CallAnalysis, Sentiment } from './analyze.js';
import { billableSeconds, callMinutesMetric, capState } from './usage.js';

export type Turn = { role: 'agent' | 'caller'; text: string };

/** What the voice worker stores at tenants/<tid>/transcripts/<callId>.json, reduced to what post-call uses. */
export interface LoadedTranscript {
  turns: Turn[];
  /** From carrier signalling. Not proof of identity, only a merge key for the customer record. */
  callerE164?: string;
}

/** In the order they run. `usageEvent` is the usage.recorded event, `live` the conversation.message event. */
export const STEPS = ['usage', 'usageEvent', 'stripe', 'analysis', 'crm', 'live'] as const;
export type Step = (typeof STEPS)[number];

export interface StoredAnalysis {
  summary: string;
  sentiment: Sentiment;
  intents: string[];
  /** Kept so the customer step can run on a later attempt without reading the transcript again. */
  callerE164?: string;
}
export interface CallProgress {
  /** Steps already finished for this call. */
  done: ReadonlySet<Step>;
  /** Result of the usage step: the seconds billed and the month's totals after this call. */
  usage?: { seconds: number; usedSec: number; capSec: number };
  analysis?: StoredAnalysis;
}
export type StepOutput = Partial<Pick<CallProgress, 'usage' | 'analysis'>>;

/** Exclusive right to work on one call, until released or until it runs out. */
export interface CallLease {
  readonly progress: CallProgress;
  /** Marks a step finished and saves its output. Throws LeaseLostError when another invocation has taken over. */
  record(step: Step, output?: StepOutput): Promise<void>;
  /** Gives the lease back so a retry can start right away. Never throws. */
  release(): Promise<void>;
}
export interface CallLedger {
  /** Returns the lease, or undefined while another invocation holds it. */
  begin(tenantId: string, callId: string): Promise<CallLease | undefined>;
}

export class LeaseLostError extends Error {
  constructor(tenantId: string, callId: string) {
    super(`lost the lease on call ${tenantId}/${callId}`);
    this.name = 'LeaseLostError';
  }
}

const errorName = (e: unknown): string => (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : 'Error');

/** One or more steps failed. The steps that finished stay finished; the event is retried for the rest. */
export class PostCallError extends Error {
  constructor(readonly failures: ReadonlyArray<{ step: Step; error: unknown }>) {
    super(`post-call steps failed: ${failures.map((f) => `${f.step} (${errorName(f.error)})`).join(', ')}`);
    this.name = 'PostCallError';
    if (failures[0]) this.cause = failures[0].error;
  }
}

/** The conversation as the owner's dashboard lists it (CONV#<startedAt>#<callId>, contracts/dynamodb/keys.md). */
export interface ConversationRecord {
  tenantId: string;
  callId: string;
  /** Derived from the event: when it was emitted minus the call length. The same on every replay. */
  startedAt: string;
  channel: 'voice' | 'webchat';
  durationSec: number;
  endReason: CallEndedData['endReason'];
  transcriptKey: string;
  summary: string;
  sentiment: Sentiment;
  intents: string[];
  naturalness: CallAnalysis['naturalness'];
}

export interface AnalyzeRequest {
  tenantId: string;
  callId: string;
  channel: 'voice' | 'chat';
  transcript: Turn[];
}

export interface PostCallDeps {
  /** Per-call progress and lease. Production: createDynamoLedger (deps.ts). */
  ledger: CallLedger;
  /** undefined when the object is gone or unreadable: there is nothing to analyse, and retrying will not change that. */
  loadTranscript(key: string): Promise<LoadedTranscript | undefined>;
  /** Bedrock analysis plus naturalness (G1). The transcript is data, the reply is schema-checked JSON. */
  analyze(input: AnalyzeRequest): Promise<CallAnalysis>;
  saveConversation(record: ConversationRecord): Promise<void>;
  /** G2 (crm.ts). Merges by phone, never overwrites what the owner edited. Must be safe to repeat for one callId. */
  upsertCustomerFromCall(tenantId: string, callId: string, summary: string, caller?: { phone?: string }): Promise<void>;
  /** G2 (usage-store.ts). Atomic monthly counter. Must count a callId once however often it is called. */
  addUsage(tenantId: string, callId: string, seconds: number): Promise<{ usedSec: number; capSec: number }>;
  /** G2 (stripe-usage.ts). Idempotency key is the callId. */
  reportStripeUsage(tenantId: string, callId: string, seconds: number): Promise<void>;
  publish(e: EventEnvelope): Promise<void>;
  /** Structured log lines. Never pass call content here. */
  log?(line: Record<string, unknown>): void;
}

export type CallEndedResult =
  | { skipped: true; reason: 'already_processed' | 'in_progress' | 'invalid_event' }
  | { skipped: false; seconds: number; ran: Step[] };

/** EventBridge target for call.ended (both engines emit the same normalized event). CRM write lives here (Change-12). */
export async function onCallEnded(evt: EventEnvelope<CallEndedData>, deps: PostCallDeps): Promise<CallEndedResult> {
  const { tenantId, data } = evt;
  const callId = data.callId;
  const say = (line: Record<string, unknown>) => deps.log?.({ msg: 'post-call', callId, tenantId, ...line });

  const lease = await deps.ledger.begin(tenantId, callId);
  if (!lease) {
    say({ status: 'skipped', reason: 'in_progress' });
    return { skipped: true, reason: 'in_progress' };
  }

  try {
    const seconds = billableSeconds(data.durationSec);
    const transcriptKey = data.transcriptKey || undefined;
    const done = new Set<Step>(lease.progress.done);
    let usage = lease.progress.usage;
    let analysis = lease.progress.analysis;
    // The totals feed the usage event. If they cannot be read back, count the call again: addUsage is idempotent
    // per call id and returns the totals.
    if (done.has('usage') && !usage) done.delete('usage');

    const applicable = STEPS.filter((s) => {
      if (s === 'stripe') return seconds > 0;
      if (s === 'analysis') return transcriptKey !== undefined;
      if (s === 'crm' || s === 'live') return transcriptKey !== undefined && (!done.has('analysis') || analysis !== undefined);
      return true;
    });
    if (applicable.every((s) => done.has(s))) {
      say({ status: 'skipped', reason: 'already_processed' });
      return { skipped: true, reason: 'already_processed' };
    }

    const failures: Array<{ step: Step; error: unknown }> = [];
    const ran: Step[] = [];
    /** Runs one step unless it is already done, and records it. Returns whether the step is done afterwards. */
    const step = async (name: Step, work: () => Promise<StepOutput | void>): Promise<boolean> => {
      if (done.has(name)) return true;
      try {
        const out = (await work()) ?? undefined;
        await lease.record(name, out);
        done.add(name);
        if (out?.usage) usage = out.usage;
        if (out?.analysis) analysis = out.analysis;
        ran.push(name);
        say({ step: name, status: 'done' });
        return true;
      } catch (error) {
        // Someone else owns the call now. Doing more work would double it, so stop.
        if (error instanceof LeaseLostError) throw error;
        failures.push({ step: name, error });
        say({ step: name, status: 'failed', error: errorName(error) });
        return false;
      }
    };

    // Usage first: it is what the customer is billed on, and it needs nothing from the transcript.
    await step('usage', async () => {
      const total = await deps.addUsage(tenantId, callId, seconds);
      return { usage: { seconds, usedSec: total.usedSec, capSec: total.capSec } };
    });
    // Once per call, after the step is recorded. A crash in between loses one data point instead of doubling it.
    if (ran.includes('usage')) deps.log?.(callMinutesMetric(tenantId, callId, data.durationSec, new Date(evt.occurredAt)));
    const billed = usage;
    if (done.has('usage') && billed) {
      // The only engine that puts call.ended on the bus today is the LiveKit worker. When the ElevenLabs path does, the
      // event needs an engine field of its own; engineConversationId is not defined to mean that (contracts/events).
      await step('usageEvent', () => deps.publish(makeEvent('usage.recorded', evt, { callId, billableSeconds: billed.seconds, engine: 'livekit-telnyx', cap: capState(billed.usedSec, billed.capSec) })));
    }
    if (seconds > 0) await step('stripe', () => deps.reportStripeUsage(tenantId, callId, seconds));

    if (transcriptKey !== undefined) {
      const analysed = await step('analysis', async () => {
        const loaded = await deps.loadTranscript(transcriptKey);
        if (!loaded || loaded.turns.length === 0) return {}; // nothing was said, or the object is gone
        const result = await deps.analyze({ tenantId, callId, channel: data.channel === 'webchat' ? 'chat' : 'voice', transcript: loaded.turns });
        await deps.saveConversation({
          tenantId,
          callId,
          startedAt: new Date(Date.parse(evt.occurredAt) - data.durationSec * 1000).toISOString(),
          channel: data.channel === 'webchat' ? 'webchat' : 'voice',
          durationSec: data.durationSec,
          endReason: data.endReason,
          transcriptKey,
          summary: result.summary,
          sentiment: result.sentiment,
          intents: result.intents,
          naturalness: result.naturalness,
        });
        return { analysis: { summary: result.summary, sentiment: result.sentiment, intents: result.intents, ...(loaded.callerE164 ? { callerE164: loaded.callerE164 } : {}) } };
      });
      const said = analysis;
      if (analysed && said) {
        await step('crm', () => deps.upsertCustomerFromCall(tenantId, callId, said.summary, said.callerE164 ? { phone: said.callerE164 } : {}));
        await step('live', () => deps.publish(makeEvent('conversation.message', evt, { callId, summary: said.summary, sentiment: said.sentiment, intents: said.intents })));
      }
    }

    if (failures.length > 0) throw new PostCallError(failures);
    return { skipped: false, seconds, ran };
  } finally {
    await lease.release().catch(() => undefined);
  }
}
