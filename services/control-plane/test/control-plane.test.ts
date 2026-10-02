import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { actionForStripeEvent, verifyStripeSignature } from '../src/stripe.js';

describe('stripe webhook', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  const sig = (t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  it('verifies a fresh signature', () => expect(verifyStripeSignature(body, sig(now), secret, 300, now)).toBe(true));
  it('rejects replays outside tolerance', () => expect(verifyStripeSignature(body, sig(now - 400), secret, 300, now)).toBe(false));
  it('maps subscription deletion to suspension', () => {
    expect(actionForStripeEvent('customer.subscription.deleted', {})).toEqual({ kind: 'set_state', state: 'suspended' });
  });
});
