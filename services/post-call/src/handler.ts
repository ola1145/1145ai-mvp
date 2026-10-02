import { makeEvent, type CallEndedData, type EventEnvelope } from '@1145/shared';
import { billableSeconds, capState } from './usage.js';

export interface PostCallDeps {
  alreadyProcessed(tenantId: string, callId: string): Promise<boolean>;      // conditional put on POSTCALL#<callId>
  loadTranscript(key: string): Promise<Array<{ role: 'agent' | 'caller'; text: string }>>;
  analyze(transcript: Array<{ role: string; text: string }>): Promise<{ summary: string; sentiment: 'positive' | 'neutral' | 'negative'; intents: string[] }>;
  upsertCustomerFromCall(tenantId: string, callId: string, summary: string): Promise<void>;
  addUsage(tenantId: string, seconds: number): Promise<{ usedSec: number; capSec: number }>;
  publish(e: EventEnvelope): Promise<void>;
}

/** EventBridge target for call.ended (both engines emit the same normalized event). CRM write lives here (Change-12). */
export async function onCallEnded(evt: EventEnvelope<CallEndedData>, deps: PostCallDeps) {
  const { tenantId, data } = evt;
  if (await deps.alreadyProcessed(tenantId, data.callId)) return { skipped: true };

  const seconds = billableSeconds(data.durationSec);
  const usage = await deps.addUsage(tenantId, seconds);
  await deps.publish(makeEvent('usage.recorded', evt, { callId: data.callId, billableSeconds: seconds, engine: 'livekit-telnyx', cap: capState(usage.usedSec, usage.capSec) }));

  if (data.transcriptKey) {
    const transcript = await deps.loadTranscript(data.transcriptKey);
    // The transcript is caller-controlled text: the analysis prompt treats it as quoted data and returns JSON only.
    const analysis = await deps.analyze(transcript);
    await deps.upsertCustomerFromCall(tenantId, data.callId, analysis.summary);
    await deps.publish(makeEvent('conversation.message', evt, { callId: data.callId, summary: analysis.summary, sentiment: analysis.sentiment, intents: analysis.intents }));
  }
  return { skipped: false, seconds };
}
