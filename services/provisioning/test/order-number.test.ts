import { describe, expect, it } from 'vitest';
import { orderNumber, type OrderState } from '../src/steps/order-number.js';
import { TelnyxRejectedError, TelnyxTransientError, type TelnyxOrder } from '../src/lib/telnyx.js';

/**
 * Everything here is a hand-written fake. No Telnyx call is made and no number is bought.
 * `FakeTelnyx.purchases` is the ledger of numbers that would have cost money.
 */
class FakeTelnyx {
  purchases: Array<{ number: string; ref: string; orderId: string }> = [];
  rejected = new Set<string>();           // numbers Telnyx refuses with a 4xx (taken meanwhile)
  failAfterBuying: Error | undefined;     // order is created at the vendor, then the response is lost
  failBeforeBuying: Error | undefined;    // nothing is created
  lookupFails = false;                    // lookup is down once an order call has been attempted
  attempts = 0;

  async order(number: string, _conn: string, ref: string) {
    this.attempts++;
    if (this.failBeforeBuying) throw this.failBeforeBuying;
    if (this.rejected.has(number)) throw new TelnyxRejectedError('number unavailable', 422);
    const orderId = `ord${this.purchases.length + 1}`;
    this.purchases.push({ number, ref, orderId });
    if (this.failAfterBuying) throw this.failAfterBuying;
    return { orderId, status: 'pending' };
  }
  async findOrderByReference(ref: string): Promise<TelnyxOrder | undefined> {
    if (this.lookupFails && this.attempts > 0) throw new TelnyxTransientError('lookup down');
    const p = this.purchases.find((x) => x.ref === ref);
    return p ? { orderId: p.orderId, status: 'pending', numbers: [p.number] } : undefined;
  }
}

function memoryState(): OrderState & { saved: Map<string, { number: string; orderId: string }> } {
  const saved = new Map<string, { number: string; orderId: string }>();
  return {
    saved,
    get: async (id) => saved.get(id),
    put: async (id, v) => (saved.has(id) ? false : (saved.set(id, v), true)),
  };
}

const input = { onboardingId: 'onb_1', tenantId: 't_abcdefgh1', candidates: ['+12145550100', '+12145550101', '+12145550102'], connectionId: 'conn_1' };

describe('orderNumber: never buys twice', () => {
  it('a plain re-invocation returns the saved order and does not call Telnyx', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    const first = await orderNumber(input, { telnyx, state });
    const second = await orderNumber(input, { telnyx, state });
    expect(second).toEqual(first);
    expect(telnyx.purchases).toHaveLength(1);
    expect(telnyx.attempts).toBe(1);
  });

  it('FORCED RETRY: the first run buys, then dies before saving state; the retry buys nothing new', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    let crash = true;
    const crashingState: OrderState = { get: state.get, put: async (id, v) => { if (crash) throw new Error('lambda killed before ORDER# write'); return state.put(id, v); } };
    await expect(orderNumber(input, { telnyx, state: crashingState })).rejects.toThrow('lambda killed');
    crash = false;
    const retried = await orderNumber(input, { telnyx, state: crashingState });
    expect(telnyx.purchases).toHaveLength(1);                       // one number bought in total
    expect(telnyx.attempts).toBe(1);                                // the retry never called order() again
    expect(retried).toEqual({ number: '+12145550100', orderId: 'ord1' });
    expect(state.saved.get('onb_1')).toEqual(retried);
  });

  it('FORCED RETRY: the order succeeded at Telnyx but the response timed out; retry adopts it', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    telnyx.failAfterBuying = new TelnyxTransientError('timeout');
    // First attempt: ambiguous error, order exists at the vendor, so it is adopted in the same invocation.
    const a = await orderNumber(input, { telnyx, state });
    expect(a.number).toBe('+12145550100');
    expect(telnyx.purchases).toHaveLength(1);
    const b = await orderNumber(input, { telnyx, state });
    expect(b).toEqual(a);
    expect(telnyx.purchases).toHaveLength(1);
  });

  it('an ambiguous error with no order found never moves on to the next candidate', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    telnyx.failBeforeBuying = new TelnyxTransientError('503', 503);
    await expect(orderNumber(input, { telnyx, state })).rejects.toThrow(/503/);
    expect(telnyx.attempts).toBe(1);                                // not 3: a failed call may still have bought the number
    expect(telnyx.purchases).toHaveLength(0);
  });

  it('an ambiguous error with the lookup also down fails the step so Step Functions retries', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    telnyx.failAfterBuying = new TelnyxTransientError('timeout'); telnyx.lookupFails = true;
    await expect(orderNumber(input, { telnyx, state })).rejects.toThrow();
    expect(telnyx.purchases).toHaveLength(1);
    telnyx.failAfterBuying = undefined; telnyx.lookupFails = false;
    const retried = await orderNumber(input, { telnyx, state });    // next attempt finds the earlier order by reference
    expect(retried.number).toBe('+12145550100');
    expect(telnyx.purchases).toHaveLength(1);
  });

  it('an order found by reference is adopted without ordering', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    telnyx.purchases.push({ number: '+12145550199', ref: 'onb:onb_1', orderId: 'ordX' });
    const r = await orderNumber(input, { telnyx, state });
    expect(r).toEqual({ number: '+12145550199', orderId: 'ordX' });
    expect(telnyx.attempts).toBe(0);
  });

  it('concurrent writers: the first ORDER# write wins and both callers see the same number', async () => {
    const telnyx = new FakeTelnyx();
    const winner = { number: '+12145550150', orderId: 'ordW' };
    const saved = new Map<string, { number: string; orderId: string }>();
    let reads = 0;
    const state: OrderState = {
      get: async (id) => (reads++ === 0 ? undefined : saved.get(id)),
      put: async (id, v) => { saved.set(id, winner); void v; return false; },
    };
    const r = await orderNumber(input, { telnyx, state });
    expect(r).toEqual(winner);
  });
});

describe('orderNumber: candidates', () => {
  it('a number taken meanwhile (4xx) moves to the next candidate and buys exactly one', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    telnyx.rejected.add('+12145550100');
    const r = await orderNumber(input, { telnyx, state });
    expect(r.number).toBe('+12145550101');
    expect(telnyx.purchases).toHaveLength(1);
  });

  it('every candidate rejected: NoNumberAvailable, nothing bought, nothing saved', async () => {
    const telnyx = new FakeTelnyx(); const state = memoryState();
    input.candidates.forEach((c) => telnyx.rejected.add(c));
    const err = await orderNumber(input, { telnyx, state }).catch((e: Error) => e);
    expect((err as Error).name).toBe('NoNumberAvailable');
    expect(telnyx.purchases).toHaveLength(0);
    expect(state.saved.size).toBe(0);
  });

  it('works with a client that cannot look up orders (older fakes): sequential retry still buys once', async () => {
    let orders = 0;
    const state = memoryState();
    const telnyx = { order: async () => ({ orderId: `ord${++orders}`, status: 'pending' }) };
    await orderNumber(input, { telnyx, state });
    await orderNumber(input, { telnyx, state });
    expect(orders).toBe(1);
  });
});
