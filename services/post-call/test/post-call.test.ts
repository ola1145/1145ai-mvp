import { describe, expect, it } from 'vitest';
import { billableSeconds, capState } from '../src/usage.js';
import { onCallEnded } from '../src/handler.js';
import { asTenantId, makeEvent, type EventEnvelope } from '@1145/shared';

describe('usage', () => {
  it('rounds up to 6-second increments', () => {
    expect(billableSeconds(61)).toBe(66);
    expect(billableSeconds(0)).toBe(0);
  });
  it('warns at 80% of cap', () => {
    expect(capState(800, 1000)).toBe('warn');
    expect(capState(1000, 1000)).toBe('over');
  });
});

describe('onCallEnded', () => {
  it('is idempotent per call id', async () => {
    const seen = new Set<string>();
    const published: EventEnvelope[] = [];
    const deps = {
      alreadyProcessed: async (_t: string, c: string) => (seen.has(c) ? true : (seen.add(c), false)),
      loadTranscript: async () => [{ role: 'caller' as const, text: 'book me in' }],
      analyze: async () => ({ summary: 'Booked a haircut', sentiment: 'positive' as const, intents: ['book'] }),
      upsertCustomerFromCall: async () => {},
      addUsage: async () => ({ usedSec: 60, capSec: 3000 }),
      publish: async (e: EventEnvelope) => { published.push(e); },
    };
    const evt = makeEvent('call.ended', { tenantId: asTenantId('t_tenanta01'), correlationId: 'call-9' }, { callId: 'call-9', durationSec: 95, endReason: 'caller_hangup' as const, transcriptKey: 'k' });
    await onCallEnded(evt, deps);
    await onCallEnded(evt, deps);
    expect(published.map((e) => e.type)).toEqual(['usage.recorded', 'conversation.message']);
  });
});
