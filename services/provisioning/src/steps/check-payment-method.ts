/**
 * Step: fail with NeedsPaymentMethod (and emit onboarding.status) until a card is on file.
 * Owner: issue D9 (tasks/D9.md).
 */
export async function handler(_event: unknown): Promise<unknown> {
  throw new Error('check-payment-method not implemented (D9)');
}
