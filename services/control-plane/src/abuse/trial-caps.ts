/**
 * Trial minute cap. One verified identity (card fingerprint or Cognito sub) gets one
 * trial tenant. A second tenant on that identity draws no free seconds, and a tenant
 * cannot be re-keyed onto a fresh identity to reset the allowance.
 *
 * identityKey comes from billing or the auth claim. It is never taken from model output.
 */
import { asTenantId } from '@1145/shared';

/** 30 minutes of free talk time for the first tenant on a verified identity. */
export const TRIAL_FREE_SECONDS = 30 * 60;

const IDENTITY_RE = /^[A-Za-z0-9_.:-]{6,128}$/;

export interface TrialUsage {
  key: string;
  grantedFreeSec: number;
}

export interface TrialAccount {
  tenantId: string;
  identityKey: string;
  usedSec: number;
  paid: boolean;
  openedAtMs: number;
  applied: readonly TrialUsage[];
}

export type TrialState = 'ok' | 'over_cap' | 'identity_exhausted' | 'unverified' | 'identity_mismatch';

export interface TrialDecision {
  state: TrialState;
  /** Free seconds this request may consume. Paid usage is not granted here. */
  grantedFreeSec: number;
  /** False once the tenant is paid. Paid minutes are metered by post-call, not this pool. */
  onTrial: boolean;
  remainingFreeSec: number;
  duplicate: boolean;
  accounts: readonly TrialAccount[];
}

export interface TrialRequest {
  tenantId: string;
  /** Empty means the tenant has no verified card or login, so it gets no free minutes. */
  identityKey: string;
  additionalSec: number;
  paid?: boolean;
  capSec?: number;
  nowMs?: number;
  /** Call id (or other idempotency key). A replay returns the original grant and does not add seconds. */
  usageKey?: string;
}

function identityOf(raw: string): string | undefined {
  const key = raw.trim();
  if (!key) return undefined;
  if (!IDENTITY_RE.test(key)) throw new Error('invalid identity key');
  return key;
}

function capOf(capSec: number | undefined): number {
  const cap = capSec ?? TRIAL_FREE_SECONDS;
  if (!Number.isFinite(cap) || cap < 0) throw new Error('capSec must be >= 0');
  return cap;
}

function ownerOf(accounts: readonly TrialAccount[], identityKey: string): TrialAccount | undefined {
  let owner: TrialAccount | undefined;
  for (const account of accounts) {
    if (account.identityKey !== identityKey) continue;
    if (!owner || account.openedAtMs < owner.openedAtMs || (account.openedAtMs === owner.openedAtMs && account.tenantId < owner.tenantId)) {
      owner = account;
    }
  }
  return owner;
}

function withAccount(accounts: readonly TrialAccount[], next: TrialAccount): TrialAccount[] {
  let found = false;
  const updated = accounts.map((account) => {
    if (account.tenantId !== next.tenantId) return account;
    found = true;
    return next;
  });
  return found ? updated : [...accounts, next];
}

function decision(
  state: TrialState,
  grantedFreeSec: number,
  onTrial: boolean,
  remainingFreeSec: number,
  accounts: readonly TrialAccount[],
  duplicate = false,
): TrialDecision {
  return { state, grantedFreeSec, onTrial, remainingFreeSec, duplicate, accounts };
}

/**
 * Draw free seconds for one tenant. Returns a new account list; the input list is not modified.
 */
export function grantTrialSeconds(accounts: readonly TrialAccount[], request: TrialRequest): TrialDecision {
  const tenantId = asTenantId(request.tenantId);
  if (!Number.isFinite(request.additionalSec) || request.additionalSec < 0) throw new Error('additionalSec must be >= 0');
  const cap = capOf(request.capSec);
  const identityKey = identityOf(request.identityKey);
  if (!identityKey) return decision('unverified', 0, false, 0, accounts);

  const existing = accounts.find((account) => account.tenantId === tenantId);
  if (existing && existing.identityKey !== identityKey) return decision('identity_mismatch', 0, false, 0, accounts);

  const owner = ownerOf(accounts, identityKey);
  if (owner && owner.tenantId !== tenantId) {
    return decision('identity_exhausted', 0, false, Math.max(0, cap - owner.usedSec), accounts);
  }

  const nowMs = request.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite');
  const paid = request.paid === true || existing?.paid === true;
  const usedSec = existing?.usedSec ?? 0;
  const remainingFreeSec = Math.max(0, cap - usedSec);

  if (paid) {
    const account: TrialAccount = {
      tenantId,
      identityKey,
      usedSec,
      paid: true,
      openedAtMs: existing?.openedAtMs ?? nowMs,
      applied: existing?.applied ?? [],
    };
    const unchanged = existing?.paid === true && existing.usedSec === usedSec && existing.identityKey === identityKey;
    return decision('ok', 0, false, remainingFreeSec, unchanged ? accounts : withAccount(accounts, account));
  }

  if (request.usageKey) {
    if (request.usageKey.length > 128 || request.usageKey.includes('#')) throw new Error('invalid usage key');
    const prior = existing?.applied.find((usage) => usage.key === request.usageKey);
    if (prior) {
      return decision(usedSec >= cap ? 'over_cap' : 'ok', prior.grantedFreeSec, true, remainingFreeSec, accounts, true);
    }
  }

  const grantedFreeSec = Math.min(request.additionalSec, remainingFreeSec);
  const nextUsed = usedSec + grantedFreeSec;
  const applied = request.usageKey && grantedFreeSec > 0
    ? [...(existing?.applied ?? []), { key: request.usageKey, grantedFreeSec }]
    : existing?.applied ?? [];
  const account: TrialAccount = {
    tenantId,
    identityKey,
    usedSec: nextUsed,
    paid: false,
    openedAtMs: existing?.openedAtMs ?? nowMs,
    applied,
  };
  const state: TrialState = nextUsed >= cap && request.additionalSec > 0 ? 'over_cap' : 'ok';
  return decision(state, grantedFreeSec, true, Math.max(0, cap - nextUsed), withAccount(accounts, account));
}
