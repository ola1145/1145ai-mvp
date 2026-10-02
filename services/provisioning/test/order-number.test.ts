import { describe, expect, it } from 'vitest';
import { orderNumber } from '../src/steps/order-number.js';

describe('orderNumber', () => {
  it('never buys twice for one onboarding (retry safety)', async () => {
    let orders = 0;
    const saved = new Map<string, { number: string; orderId: string }>();
    const deps = {
      telnyx: { searchLocal: async () => [], order: async () => ({ orderId: `ord${++orders}`, status: 'pending' }) },
      state: { get: async (id: string) => saved.get(id), put: async (id: string, v: { number: string; orderId: string }) => (saved.has(id) ? false : (saved.set(id, v), true)) },
    };
    const input = { onboardingId: 'o1', tenantId: 't_a', candidates: ['+12145550100'], connectionId: 'c1' };
    await orderNumber(input, deps);
    await orderNumber(input, deps);
    expect(orders).toBe(1);
  });
});
