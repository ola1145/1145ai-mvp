import type { TelnyxClient } from '../lib/telnyx.js';

export interface OrderNumberInput { onboardingId: string; tenantId: string; candidates: string[]; connectionId: string }
export interface OrderState { get(onboardingId: string): Promise<{ number: string; orderId: string } | undefined>; put(onboardingId: string, v: { number: string; orderId: string }): Promise<boolean> }

/**
 * Step Functions retries this Lambda. Without the OrderState check, a retry after a timeout buys a second number.
 * OrderState.put is a conditional write on ORDER#<onboardingId>; the first writer wins.
 * Card-on-file / deposit is checked by the state machine BEFORE this step (abuse control).
 */
export async function orderNumber(input: OrderNumberInput, deps: { telnyx: TelnyxClient; state: OrderState }) {
  const existing = await deps.state.get(input.onboardingId);
  if (existing) return existing;
  for (const candidate of input.candidates) {
    try {
      const r = await deps.telnyx.order(candidate, input.connectionId, `onb:${input.onboardingId}`);
      const v = { number: candidate, orderId: r.orderId };
      if (await deps.state.put(input.onboardingId, v)) return v;
      return (await deps.state.get(input.onboardingId))!;
    } catch (err) {
      console.warn(JSON.stringify({ level: 'warn', step: 'order-number', candidate, err: String(err) })); // number taken meanwhile: try next
    }
  }
  throw new Error('NoNumberAvailable'); // state machine catches -> widen search area -> retry
}
