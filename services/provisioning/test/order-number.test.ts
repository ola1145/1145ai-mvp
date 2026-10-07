import { describe, expect, it } from 'vitest';
import { ddbOrderState, orderNumber, type OrderState } from '../src/steps/order-number.js';
import { TelnyxRejectedError, TelnyxTransientError, type TelnyxOrder } from '../src/lib/telnyx.js';

type Intent = { candidate: string; at: string };

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


/**
 * SEC-18 (docs/security/threat-model.md): the order succeeded at Telnyx but the ORDER# write did not land.
 * The vendor's list endpoints can lag behind a fresh order, so "no order found by reference" is not proof that nothing
 * was bought. The step therefore records which number it is about to buy BEFORE spending money, and a retry settles
 * that number first (owned? then adopt it) instead of walking on to the next candidate.
 */
describe('orderNumber: SEC-18 failure between the order and the state write', () => {
  class LaggyTelnyx {
    purchases: Array<{ number: string; ref: string; orderId: string }> = [];
    owned = new Set<string>();
    referenceLag = false;                 // findOrderByReference does not see a fresh order yet
    ownedLag = false;                     // neither does the owned-numbers list
    failBeforeBuying: Error | undefined;
    ownedLookupFails = false;
    orderCalls: string[] = [];
    async order(number: string, _conn: string, ref: string) {
      this.orderCalls.push(number);
      if (this.failBeforeBuying) throw this.failBeforeBuying;
      if (this.owned.has(number)) throw new TelnyxRejectedError('number not available', 422); // we already own it: Telnyx refuses a second order
      const orderId = `ord${this.purchases.length + 1}`;
      this.purchases.push({ number, ref, orderId });
      this.owned.add(number);
      return { orderId, status: 'pending' };
    }
    async findOrderByReference(ref: string): Promise<TelnyxOrder | undefined> {
      if (this.referenceLag) return undefined;
      const p = this.purchases.find((x) => x.ref === ref);
      return p ? { orderId: p.orderId, status: 'pending', numbers: [p.number] } : undefined;
    }
    async findOwnedNumber(number: string) {
      if (this.ownedLookupFails) throw new TelnyxTransientError('owned lookup down');
      return !this.ownedLag && this.owned.has(number) ? { id: `pn_${number.slice(-4)}` } : undefined;
    }
  }

  function intentState() {
    const saved = new Map<string, { number: string; orderId: string }>();
    const intents = new Map<string, Intent>();
    const released: string[] = [];
    let failPut = false; let failBegin = false;
    const state: OrderState = {
      get: async (id) => saved.get(id),
      put: async (id, v) => { if (failPut) throw new Error('dynamodb write failed after the order'); if (saved.has(id)) return false; saved.set(id, v); intents.delete(id); return true; },
      begin: async (id, candidate, now) => { if (failBegin) throw new Error('dynamodb unavailable'); const cur = intents.get(id); if (!cur) intents.set(id, { candidate, at: now.toISOString() }); else if (cur.candidate !== candidate) throw new Error('another candidate is pending'); },
      pending: async (id) => intents.get(id),
      release: async (id, candidate) => { released.push(candidate); if (intents.get(id)?.candidate === candidate) intents.delete(id); },
    };
    return { state, saved, intents, released, failPut: (v: boolean) => { failPut = v; }, failBegin: (v: boolean) => { failBegin = v; } };
  }

  const t0 = new Date('2026-10-06T12:00:00.000Z');
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it('write fails after a successful order and the vendor lists lag: the retry adopts the number it started buying, never a second one', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.referenceLag = true; telnyx.ownedLag = true;
    s.failPut(true);
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow(/dynamodb write failed/);
    expect(telnyx.purchases).toHaveLength(1);
    // Retry a while later: the number now shows in the owned list, the order list is still behind.
    s.failPut(false); telnyx.ownedLag = false;
    const retried = await orderNumber(input, { telnyx, state: s.state, now: () => later(20_000) });
    expect(retried.number).toBe('+12145550100');
    expect(telnyx.purchases).toHaveLength(1);                     // one number bought in total
    expect(telnyx.orderCalls).toEqual(['+12145550100']);           // the retry never called order() at all
    expect(s.saved.get('onb_1')?.number).toBe('+12145550100');
  });

  it('a retry right after an unfinished attempt waits (transient error) instead of guessing', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.referenceLag = true; telnyx.ownedLag = true;
    s.failPut(true);
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow();
    s.failPut(false);
    const err = await orderNumber(input, { telnyx, state: s.state, now: () => later(2_000) }).catch((e: Error) => e);
    expect((err as Error).name).toBe('TelnyxTransientError');     // the state machine retries this error name
    expect(telnyx.orderCalls).toEqual(['+12145550100']);           // still only the first order call
    expect(s.saved.size).toBe(0);
  });

  it('an unfinished attempt that bought nothing is settled after the wait: same candidate again, still one purchase', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.failBeforeBuying = new TelnyxTransientError('503', 503); // the order call itself never reached Telnyx's ledger
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow(/503/);
    expect(s.intents.get('onb_1')?.candidate).toBe('+12145550100');
    telnyx.failBeforeBuying = undefined;
    const r = await orderNumber(input, { telnyx, state: s.state, now: () => later(60_000) });
    expect(r.number).toBe('+12145550100');
    expect(telnyx.purchases).toHaveLength(1);
    expect(s.released).toContain('+12145550100');
  });

  it('when the owned-numbers lookup is down the step fails rather than assuming nothing was bought', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.referenceLag = true;
    s.failPut(true);
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow();
    s.failPut(false); telnyx.ownedLookupFails = true;
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => later(60_000) })).rejects.toBeInstanceOf(TelnyxTransientError);
    expect(telnyx.orderCalls).toHaveLength(1);
    expect(telnyx.purchases).toHaveLength(1);
  });

  it('a new execution that searched again (different candidates) still adopts the number an earlier run started buying', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.referenceLag = true;
    s.failPut(true);
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow();
    s.failPut(false);
    const fresh = { ...input, candidates: ['+12145550177', '+12145550178'] };
    const r = await orderNumber(fresh, { telnyx, state: s.state, now: () => later(60_000) });
    expect(r.number).toBe('+12145550100');
    expect(telnyx.purchases).toHaveLength(1);
  });

  it('the intent is written before the order call, and a state that cannot record it stops the purchase', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    s.failBegin(true);
    await expect(orderNumber(input, { telnyx, state: s.state, now: () => t0 })).rejects.toThrow(/dynamodb unavailable/);
    expect(telnyx.orderCalls).toEqual([]);
    expect(telnyx.purchases).toEqual([]);
  });

  it('a definite rejection releases the intent so the next candidate can be tried', async () => {
    const telnyx = new LaggyTelnyx(); const s = intentState();
    telnyx.owned.add('+12145550100');                              // someone else's number: Telnyx refuses with a 4xx
    const r = await orderNumber(input, { telnyx, state: s.state, now: () => t0 });
    expect(r.number).toBe('+12145550101');
    expect(s.released).toEqual(['+12145550100']);
    expect(telnyx.purchases).toHaveLength(1);
  });
});

describe('ddbOrderState: intent and purchase live in one ORDER# item', () => {
  /** Just enough DynamoDB to run the conditions this state uses, keyed by the exact expression text. */
  function fakeTable() {
    const items = new Map<string, Record<string, unknown>>();
    const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
    const failed = () => Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
    const client = {
      async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
        const kind = cmd.constructor.name; const i = cmd.input;
        if (kind === 'GetCommand') return { Item: items.get(keyOf(i.Key)) };
        if (kind === 'PutCommand') {
          const cur = items.get(keyOf(i.Item));
          const ok = i.ConditionExpression === 'attribute_not_exists(PK) OR attribute_not_exists(orderId)'
            ? !cur || cur.orderId === undefined
            : i.ConditionExpression === 'attribute_not_exists(PK) OR (attribute_not_exists(orderId) AND candidate = :c)'
              ? !cur || (cur.orderId === undefined && cur.candidate === i.ExpressionAttributeValues[':c'])
              : (() => { throw new Error(`unexpected condition ${i.ConditionExpression}`); })();
          if (!ok) throw failed();
          items.set(keyOf(i.Item), { ...i.Item });
          return {};
        }
        if (kind === 'DeleteCommand') {
          const cur = items.get(keyOf(i.Key));
          if (i.ConditionExpression !== 'attribute_not_exists(orderId) AND candidate = :c') throw new Error(`unexpected condition ${i.ConditionExpression}`);
          if (!cur || cur.orderId !== undefined || cur.candidate !== i.ExpressionAttributeValues[':c']) throw failed();
          items.delete(keyOf(i.Key));
          return {};
        }
        throw new Error(`unexpected command ${kind}`);
      },
    };
    return { client, items };
  }
  const T = 't_abcdefgh1'; const at = new Date('2026-10-06T12:00:00.000Z');

  it('begin records the intent in the tenant partition; get does not mistake it for a purchase', async () => {
    const { client, items } = fakeTable();
    const state = ddbOrderState(client, 'tbl', T);
    await state.begin!('onb_1', '+12145550100', at);
    expect(items.get(`TENANT#${T}|ORDER#onb_1`)).toMatchObject({ candidate: '+12145550100', intentAt: at.toISOString() });
    expect(await state.get('onb_1')).toBeUndefined();
    expect(await state.pending!('onb_1')).toEqual({ candidate: '+12145550100', at: at.toISOString() });
  });

  it('put turns the intent into the purchase once, and a second put never overwrites it', async () => {
    const { client } = fakeTable();
    const state = ddbOrderState(client, 'tbl', T);
    await state.begin!('onb_1', '+12145550100', at);
    expect(await state.put('onb_1', { number: '+12145550100', orderId: 'ord1' })).toBe(true);
    expect(await state.put('onb_1', { number: '+12145550199', orderId: 'ord2' })).toBe(false);
    expect(await state.get('onb_1')).toEqual({ number: '+12145550100', orderId: 'ord1' });
    expect(await state.pending!('onb_1')).toBeUndefined();
  });

  it('begin for a different candidate while one is unsettled is refused as transient; for the same one it is a no-op', async () => {
    const { client } = fakeTable();
    const state = ddbOrderState(client, 'tbl', T);
    await state.begin!('onb_1', '+12145550100', at);
    await expect(state.begin!('onb_1', '+12145550100', at)).resolves.toBeUndefined();
    await expect(state.begin!('onb_1', '+12145550101', at)).rejects.toBeInstanceOf(TelnyxTransientError);
  });

  it('release removes only the intent for that candidate, never a purchase', async () => {
    const { client } = fakeTable();
    const state = ddbOrderState(client, 'tbl', T);
    await state.begin!('onb_1', '+12145550100', at);
    await state.release!('onb_1', '+12145550101');
    expect(await state.pending!('onb_1')).toBeDefined();
    await state.release!('onb_1', '+12145550100');
    expect(await state.pending!('onb_1')).toBeUndefined();
    await state.begin!('onb_1', '+12145550100', at);
    await state.put('onb_1', { number: '+12145550100', orderId: 'ord1' });
    await state.release!('onb_1', '+12145550100');
    expect(await state.get('onb_1')).toEqual({ number: '+12145550100', orderId: 'ord1' });
  });
});
