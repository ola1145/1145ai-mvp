/**
 * Referral rewards. A reward is granted only after the referred tenant's first paid
 * invoice, and only once per verified tenant (and per verified identity, and per invoice).
 *
 * Identity keys come from billing or the auth claim. They are never taken from the
 * referral code or from model output.
 */
import { asTenantId } from '@1145/shared';

const IDENTITY_RE = /^[A-Za-z0-9_.:-]{6,128}$/;

export interface ReferralReward {
  referrerTenantId: string;
  referredTenantId: string;
  referredIdentityKey: string;
  invoiceId: string;
}

export interface RewardRequest {
  referrerTenantId: string;
  referredTenantId: string;
  referrerIdentityKey?: string;
  referredIdentityKey?: string;
  invoiceStatus: string;
  /** True only for the referred tenant's first invoice that was actually paid. */
  firstPaidInvoice: boolean;
  invoiceId: string;
}

export type RewardDenial =
  | 'self_referral'
  | 'unverified'
  | 'referrer_unverified'
  | 'same_identity'
  | 'invoice_unpaid'
  | 'not_first_paid_invoice'
  | 'already_rewarded';

export type RewardDecision =
  | { grant: true; reward: ReferralReward }
  | { grant: false; reason: RewardDenial };

function identityOf(raw: string | undefined): string | undefined {
  const key = (raw ?? '').trim();
  if (!key) return undefined;
  if (!IDENTITY_RE.test(key)) throw new Error('invalid identity key');
  return key;
}

function deny(reason: RewardDenial): RewardDecision {
  return { grant: false, reason };
}

/**
 * Decide whether this invoice earns a referral reward. Does not mutate `existing`.
 */
export function decideReferralReward(existing: readonly ReferralReward[], request: RewardRequest): RewardDecision {
  const referrerTenantId = asTenantId(request.referrerTenantId);
  const referredTenantId = asTenantId(request.referredTenantId);
  if (!request.invoiceId || request.invoiceId.length > 128 || request.invoiceId.includes('#')) {
    throw new Error('invalid invoice id');
  }
  if (referrerTenantId === referredTenantId) return deny('self_referral');

  const referredIdentityKey = identityOf(request.referredIdentityKey);
  const referrerIdentityKey = identityOf(request.referrerIdentityKey);
  if (!referredIdentityKey) return deny('unverified');
  if (!referrerIdentityKey) return deny('referrer_unverified');
  if (referredIdentityKey === referrerIdentityKey) return deny('same_identity');
  if (request.invoiceStatus !== 'paid') return deny('invoice_unpaid');
  if (!request.firstPaidInvoice) return deny('not_first_paid_invoice');

  const taken = existing.some((reward) =>
    reward.invoiceId === request.invoiceId
    || reward.referredTenantId === referredTenantId
    || reward.referredIdentityKey === referredIdentityKey,
  );
  if (taken) return deny('already_rewarded');

  return {
    grant: true,
    reward: { referrerTenantId, referredTenantId, referredIdentityKey, invoiceId: request.invoiceId },
  };
}

export async function handler(event: unknown): Promise<RewardDecision> {
  if (!event || typeof event !== 'object') throw new Error('referral-rewards event requires existing and request');
  const body = event as { existing?: ReferralReward[]; request?: RewardRequest };
  if (!body.existing || !body.request) throw new Error('referral-rewards event requires existing and request');
  return decideReferralReward(body.existing, body.request);
}
