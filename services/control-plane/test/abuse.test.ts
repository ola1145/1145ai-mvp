import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_CALLS_PER_HOUR,
  HOUR_MS,
  SHORT_CALL_MAX_SEC,
  emptySpamLedger,
  observeCall,
  type ObservedCall,
  type SpamLedger,
} from '../src/abuse/spam-filter.js';
import { TRIAL_FREE_SECONDS, grantTrialSeconds, type TrialAccount } from '../src/abuse/trial-caps.js';
import {
  decideReferralReward,
  type ReferralReward,
  type RewardDenial,
  type RewardRequest,
} from '../src/abuse/referral-rewards.js';

const TENANT_A = 't_shopaaaa';
const TENANT_B = 't_shopbbbb';
const CALLER = '+15555550100';
const OTHER_CALLER = '+15555550199';

function call(overrides: Partial<ObservedCall> & Pick<ObservedCall, 'callId' | 'occurredAtMs'>): ObservedCall {
  return {
    tenantId: TENANT_A,
    callerId: CALLER,
    durationSec: 1,
    ...overrides,
  };
}

function fold(calls: ObservedCall[], maxShortCallsPerHour: number, start: SpamLedger = emptySpamLedger()) {
  const steps = [];
  let ledger = start;
  for (const c of calls) {
    const step = observeCall(ledger, c, { maxShortCallsPerHour });
    steps.push(step);
    ledger = step.ledger;
  }
  return { ledger, steps };
}

describe('spam calls', () => {
  it('blocks the same caller after more than N sub-3s calls in an hour, for that tenant only', () => {
    const N = 3;
    const t0 = Date.parse('2026-10-03T15:00:00Z');
    const burst = [1, 2, 3].map((i) => call({ callId: `short-${i}`, occurredAtMs: t0 + i * 1_000, durationSec: SHORT_CALL_MAX_SEC - 1 }));
    const allowed = fold(burst, N);
    expect(allowed.steps.map((s) => s.decision)).toEqual(['allow', 'allow', 'allow']);

    const before = structuredClone(allowed.ledger);
    const blocked = observeCall(allowed.ledger, call({ callId: 'short-4', occurredAtMs: t0 + 4_000, durationSec: 0 }), { maxShortCallsPerHour: N });
    expect(allowed.ledger).toEqual(before);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toBe('short_call_burst');
    expect(blocked.tenantId).toBe(TENANT_A);
    expect(blocked.callerId).toBe(CALLER);
    expect(blocked.ledger.blocks).toEqual([
      { tenantId: TENANT_A, callerId: CALLER, reason: 'short_call_burst', blockedAtMs: t0 + 4_000 },
    ]);

    const otherTenant = observeCall(
      blocked.ledger,
      call({ tenantId: TENANT_B, callId: 'b-1', occurredAtMs: t0 + 5_000, durationSec: 1 }),
      { maxShortCallsPerHour: N },
    );
    expect(otherTenant.decision).toBe('allow');
    expect(otherTenant.ledger.blocks.map((b) => b.tenantId)).toEqual([TENANT_A]);

    const stillBlocked = observeCall(
      blocked.ledger,
      call({ callId: 'later-long', occurredAtMs: t0 + HOUR_MS * 5, durationSec: 40 }),
      { maxShortCallsPerHour: N },
    );
    expect(stillBlocked).toMatchObject({ decision: 'block', reason: 'blocklisted', tenantId: TENANT_A, callerId: CALLER });
  });

  it('does not count calls of 3s or longer, other callers, or calls outside the hour', () => {
    const N = 2;
    const t0 = Date.parse('2026-10-03T15:00:00Z');
    const longs = fold(
      [
        call({ callId: 'long-1', occurredAtMs: t0, durationSec: SHORT_CALL_MAX_SEC }),
        call({ callId: 'long-2', occurredAtMs: t0 + 1, durationSec: 30 }),
      ],
      N,
    );
    expect(longs.steps.every((s) => s.decision === 'allow')).toBe(true);
    expect(longs.ledger.calls).toEqual([]);

    const mixed = fold(
      [
        call({ callId: 'a-1', occurredAtMs: t0, durationSec: 2 }),
        call({ callId: 'b-1', occurredAtMs: t0 + 1, callerId: OTHER_CALLER, durationSec: 2 }),
        call({ callId: 'a-2', occurredAtMs: t0 + 2, durationSec: 2 }),
      ],
      N,
    );
    expect(mixed.steps.map((s) => s.decision)).toEqual(['allow', 'allow', 'allow']);

    const nextHour = fold(
      [
        call({ callId: 'h-1', occurredAtMs: t0, durationSec: 1 }),
        call({ callId: 'h-2', occurredAtMs: t0 + 10, durationSec: 1 }),
        call({ callId: 'h-3', occurredAtMs: t0 + HOUR_MS + 5, durationSec: 1 }),
        call({ callId: 'h-4', occurredAtMs: t0 + HOUR_MS + 6, durationSec: 1 }),
      ],
      N,
    );
    expect(nextHour.steps.map((s) => s.decision)).toEqual(['allow', 'allow', 'allow', 'block']);
    expect(nextHour.steps[3]?.reason).toBe('short_call_burst');
  });

  it('does not let a replayed call id burn an extra slot', () => {
    const t0 = Date.parse('2026-10-03T15:00:00Z');
    const first = observeCall(emptySpamLedger(), call({ callId: 'c1', occurredAtMs: t0 }), { maxShortCallsPerHour: 1 });
    const replay = observeCall(first.ledger, call({ callId: 'c1', occurredAtMs: t0 }), { maxShortCallsPerHour: 1 });
    expect(replay.decision).toBe('allow');
    expect(replay.ledger.calls).toHaveLength(1);
    expect(replay.ledger.blocks).toEqual([]);
    const second = observeCall(replay.ledger, call({ callId: 'c2', occurredAtMs: t0 + 1 }), { maxShortCallsPerHour: 1 });
    expect(second.decision).toBe('block');
  });

  it('blocks a pre-listed caller for that tenant and applies the default hourly cap', () => {
    const listed = observeCall(
      { calls: [], blocks: [{ tenantId: TENANT_A, callerId: CALLER, reason: 'short_call_burst', blockedAtMs: 1 }] },
      call({ callId: 'x', occurredAtMs: 2, durationSec: 20 }),
      { maxShortCallsPerHour: DEFAULT_SHORT_CALLS_PER_HOUR },
    );
    expect(listed).toMatchObject({ decision: 'block', reason: 'blocklisted' });
    expect(listed.ledger.calls).toEqual([]);

    const t0 = Date.parse('2026-10-03T16:00:00Z');
    const steps = fold(
      Array.from({ length: DEFAULT_SHORT_CALLS_PER_HOUR + 1 }, (_, i) =>
        call({ callId: `d-${i}`, occurredAtMs: t0 + i * 1_000, durationSec: 2 }),
      ),
      DEFAULT_SHORT_CALLS_PER_HOUR,
    );
    expect(steps.steps.at(-1)?.decision).toBe('block');
    expect(steps.steps.at(-2)?.decision).toBe('allow');
  });

  it('treats a withheld caller as one bucket so anonymous bursts still trip the filter', () => {
    const t0 = Date.parse('2026-10-03T16:00:00Z');
    const burst = fold(
      [1, 2].map((i) => call({ callId: `w-${i}`, callerId: 'withheld', occurredAtMs: t0 + i, durationSec: 1 })),
      1,
    );
    expect(burst.steps.map((s) => s.decision)).toEqual(['allow', 'block']);
  });
});

describe('trial caps', () => {
  const identity = 'card_fp_aaaaaa';
  const otherIdentity = 'card_fp_bbbbbb';

  it('stops free seconds at the trial cap and does not open a second trial for the same identity', () => {
    expect(TRIAL_FREE_SECONDS).toBe(30 * 60);
    const claimed = grantTrialSeconds([], {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 0,
      nowMs: 1_000,
    });
    expect(claimed).toMatchObject({ state: 'ok', grantedFreeSec: 0, onTrial: true, remainingFreeSec: TRIAL_FREE_SECONDS });

    const farm = grantTrialSeconds(claimed.accounts, {
      tenantId: TENANT_B,
      identityKey: identity,
      additionalSec: 60,
      nowMs: 2_000,
    });
    expect(farm.grantedFreeSec).toBe(0);
    expect(farm.state).toBe('identity_exhausted');
    expect(farm.accounts).toEqual(claimed.accounts);

    const used = grantTrialSeconds(claimed.accounts, {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 40,
      capSec: 100,
      nowMs: 3_000,
    });
    expect(used).toMatchObject({ state: 'ok', grantedFreeSec: 40, remainingFreeSec: 60, onTrial: true });

    const partial = grantTrialSeconds(used.accounts, {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 80,
      capSec: 100,
      nowMs: 4_000,
      usageKey: 'call-cross',
    });
    expect(partial).toMatchObject({ state: 'over_cap', grantedFreeSec: 60, remainingFreeSec: 0, onTrial: true });

    const replay = grantTrialSeconds(partial.accounts, {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 80,
      capSec: 100,
      nowMs: 5_000,
      usageKey: 'call-cross',
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.grantedFreeSec).toBe(60);
    expect(replay.accounts).toBe(partial.accounts);

    const over = grantTrialSeconds(partial.accounts, {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 10,
      capSec: 100,
      nowMs: 6_000,
    });
    expect(over).toMatchObject({ state: 'over_cap', grantedFreeSec: 0, remainingFreeSec: 0 });

    const fresh = grantTrialSeconds(over.accounts, {
      tenantId: TENANT_B,
      identityKey: otherIdentity,
      additionalSec: 100,
      capSec: 100,
      nowMs: 7_000,
    });
    expect(fresh).toMatchObject({ state: 'over_cap', grantedFreeSec: 100, onTrial: true });
    expect(fresh.accounts.filter((a: TrialAccount) => a.identityKey === otherIdentity)).toHaveLength(1);
  });

  it('gives no free minutes without a verified identity, and a paid tenant does not draw the pool', () => {
    const unverified = grantTrialSeconds([], { tenantId: TENANT_A, identityKey: '', additionalSec: 30, nowMs: 1 });
    expect(unverified).toMatchObject({ state: 'unverified', grantedFreeSec: 0, onTrial: false, accounts: [] });

    const paid = grantTrialSeconds([], {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 500,
      paid: true,
      capSec: 100,
      nowMs: 1,
    });
    expect(paid).toMatchObject({ state: 'ok', grantedFreeSec: 0, onTrial: false, remainingFreeSec: 100 });
    expect(paid.accounts[0]).toMatchObject({ tenantId: TENANT_A, usedSec: 0, paid: true });

    const sibling = grantTrialSeconds(paid.accounts, {
      tenantId: TENANT_B,
      identityKey: identity,
      additionalSec: 500,
      nowMs: 2,
    });
    expect(sibling.state).toBe('identity_exhausted');
  });

  it('refuses to move a tenant onto a new identity to reset the cap', () => {
    const first = grantTrialSeconds([], {
      tenantId: TENANT_A,
      identityKey: identity,
      additionalSec: 10,
      capSec: 100,
      nowMs: 1,
    });
    const moved = grantTrialSeconds(first.accounts, {
      tenantId: TENANT_A,
      identityKey: otherIdentity,
      additionalSec: 100,
      capSec: 100,
      nowMs: 2,
    });
    expect(moved.state).toBe('identity_mismatch');
    expect(moved.grantedFreeSec).toBe(0);
    expect(moved.accounts).toEqual(first.accounts);
  });
});

describe('referral rewards', () => {
  const referrer = 't_referrer';
  const referred = 't_referred';
  const referredIdentity = 'card_fp_referred1';
  const referrerIdentity = 'card_fp_referrer1';

  function denial(existing: readonly ReferralReward[], req: RewardRequest): RewardDenial {
    const decision = decideReferralReward(existing, req);
    if (decision.grant) throw new Error('expected the reward to be denied');
    return decision.reason;
  }

  function request(overrides: Partial<RewardRequest> = {}): RewardRequest {
    return {
      referrerTenantId: referrer,
      referredTenantId: referred,
      referrerIdentityKey: referrerIdentity,
      referredIdentityKey: referredIdentity,
      invoiceStatus: 'paid',
      firstPaidInvoice: true,
      invoiceId: 'in_first',
      ...overrides,
    };
  }

  it('rewards only after the referred tenant first paid invoice, once per verified tenant', () => {
    expect(denial([], request({ invoiceStatus: 'open', firstPaidInvoice: false, invoiceId: 'in_open' }))).toBe('invoice_unpaid');
    expect(denial([], request({ firstPaidInvoice: false, invoiceId: 'in_second' }))).toBe('not_first_paid_invoice');

    const before: ReferralReward[] = [];
    const granted = decideReferralReward(before, request());
    expect(before).toEqual([]);
    expect(granted.grant).toBe(true);
    if (!granted.grant) return;
    expect(granted.reward).toEqual({
      referrerTenantId: referrer,
      referredTenantId: referred,
      referredIdentityKey: referredIdentity,
      invoiceId: 'in_first',
    });

    const rewards = [granted.reward];
    expect(denial(rewards, request())).toBe('already_rewarded');
    expect(denial(rewards, request({ referrerTenantId: TENANT_B, invoiceId: 'in_other_referrer' }))).toBe('already_rewarded');
    expect(denial(rewards, request({ referredTenantId: TENANT_B, invoiceId: 'in_alias_tenant' }))).toBe('already_rewarded');
    expect(denial(rewards, request({ referredTenantId: 't_shopcccc', referredIdentityKey: 'card_fp_cccccc' }))).toBe('already_rewarded');

    const secondFriend = decideReferralReward(rewards, request({
      referredTenantId: 't_friend001',
      referredIdentityKey: 'card_fp_friend01',
      invoiceId: 'in_friend',
    }));
    expect(secondFriend.grant).toBe(true);
  });

  it('rejects self-referral, shared identity, and unverified parties', () => {
    expect(denial([], request({ referredTenantId: referrer }))).toBe('self_referral');
    expect(denial([], request({ referredIdentityKey: referrerIdentity, referredTenantId: TENANT_B, invoiceId: 'in_same_card' }))).toBe('same_identity');
    expect(denial([], request({ referredIdentityKey: '  ' }))).toBe('unverified');
    expect(denial([], request({ referrerIdentityKey: '' }))).toBe('referrer_unverified');
  });
});
