import { hmacSha256 } from '@1145/shared';
import { timingSafeEqual } from 'node:crypto';

/** Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>]"; signed payload = `${t}.${rawBody}`. */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = hmacSha256(secret, `${t}.${rawBody}`);
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const given = Buffer.from(v ?? '', 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type BillingAction = { kind: 'none' } | { kind: 'notify_owner'; template: string } | { kind: 'set_state'; state: 'active' | 'suspended' };

/** Deterministic rules, not an agent (Change-12). Stripe Smart Retries handles the retry schedule. */
export function actionForStripeEvent(type: string, obj: { status?: string }): BillingAction {
  switch (type) {
    case 'invoice.payment_failed': return { kind: 'notify_owner', template: 'billing_payment_failed' };
    case 'invoice.paid': return { kind: 'set_state', state: 'active' };
    case 'customer.subscription.deleted': return { kind: 'set_state', state: 'suspended' };
    case 'customer.subscription.updated':
      return obj.status === 'unpaid' || obj.status === 'canceled' ? { kind: 'set_state', state: 'suspended' } : { kind: 'none' };
    default: return { kind: 'none' };
  }
}
