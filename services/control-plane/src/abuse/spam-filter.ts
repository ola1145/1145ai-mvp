/**
 * Spam-call filter. Short calls from the same caller, more than N in an hour,
 * are blocked for that tenant only. The block list does not cross tenants.
 *
 * tenantId is the tenant the dialed number resolved to. It is never taken from model output.
 */
import { asTenantId } from '@1145/shared';

/** Calls shorter than this are the spam signal. A 3s call is a real hangup, not a burst. */
export const SHORT_CALL_MAX_SEC = 3;
export const HOUR_MS = 60 * 60 * 1000;
/** More than this many sub-3s calls from one caller in an hour blocks them for the tenant. */
export const DEFAULT_SHORT_CALLS_PER_HOUR = 5;

const CALLER_RE = /^(?:\+[1-9]\d{6,14}|withheld|unknown)$/;

export interface ObservedCall {
  callId: string;
  tenantId: string;
  callerId: string;
  durationSec: number;
  occurredAtMs: number;
}

export interface CallerBlock {
  tenantId: string;
  callerId: string;
  reason: 'short_call_burst';
  blockedAtMs: number;
}

export interface SpamLedger {
  calls: ObservedCall[];
  blocks: CallerBlock[];
}

export interface SpamPolicy {
  maxShortCallsPerHour: number;
  shortCallMaxSec?: number;
  windowMs?: number;
}

export interface SpamObservation {
  ledger: SpamLedger;
  decision: 'allow' | 'block';
  reason?: 'short_call_burst' | 'blocklisted';
  tenantId: string;
  callerId: string;
}

export function emptySpamLedger(): SpamLedger {
  return { calls: [], blocks: [] };
}

function isShort(durationSec: number, maxSec: number): boolean {
  if (!Number.isFinite(durationSec)) return true;
  return durationSec < maxSec;
}

function callerIdOf(raw: string): string {
  const callerId = raw.trim();
  if (!CALLER_RE.test(callerId)) throw new Error('invalid caller id');
  return callerId;
}

function callIdOf(raw: string): string {
  if (!raw || raw.length > 128 || raw.includes('#')) throw new Error('invalid call id');
  return raw;
}

/**
 * Record one ended call and decide whether this caller is blocked for this tenant.
 * The input ledger is not modified.
 */
export function observeCall(ledger: SpamLedger, call: ObservedCall, policy: SpamPolicy): SpamObservation {
  const tenantId = asTenantId(call.tenantId);
  const callerId = callerIdOf(call.callerId);
  const callId = callIdOf(call.callId);
  if (!Number.isFinite(call.occurredAtMs)) throw new Error('occurredAtMs must be finite');
  const max = policy.maxShortCallsPerHour;
  if (!Number.isInteger(max) || max < 1) throw new Error('maxShortCallsPerHour must be a positive integer');
  const shortMax = policy.shortCallMaxSec ?? SHORT_CALL_MAX_SEC;
  const windowMs = policy.windowMs ?? HOUR_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');

  const base = { tenantId, callerId };
  if (ledger.blocks.some((b) => b.tenantId === tenantId && b.callerId === callerId)) {
    return { ledger, decision: 'block', reason: 'blocklisted', ...base };
  }
  if (ledger.calls.some((c) => c.tenantId === tenantId && c.callId === callId)) {
    return { ledger, decision: 'allow', ...base };
  }
  if (!isShort(call.durationSec, shortMax)) {
    return { ledger, decision: 'allow', ...base };
  }

  const windowStart = call.occurredAtMs - windowMs;
  const kept = ledger.calls.filter((c) => c.occurredAtMs > windowStart);
  const priorInWindow = kept.filter(
    (c) => c.tenantId === tenantId && c.callerId === callerId && c.occurredAtMs <= call.occurredAtMs && isShort(c.durationSec, shortMax),
  ).length;
  const observed: ObservedCall = { callId, tenantId, callerId, durationSec: call.durationSec, occurredAtMs: call.occurredAtMs };
  const calls = [...kept, observed];
  if (priorInWindow + 1 > max) {
    const block: CallerBlock = { tenantId, callerId, reason: 'short_call_burst', blockedAtMs: call.occurredAtMs };
    return { ledger: { calls, blocks: [...ledger.blocks, block] }, decision: 'block', reason: 'short_call_burst', ...base };
  }
  return { ledger: { calls, blocks: ledger.blocks }, decision: 'allow', ...base };
}

export async function handler(event: unknown): Promise<SpamObservation> {
  if (!event || typeof event !== 'object') throw new Error('spam-filter event requires call and ledger');
  const body = event as { call?: ObservedCall; ledger?: SpamLedger; maxShortCallsPerHour?: number };
  if (!body.call || !body.ledger) throw new Error('spam-filter event requires call and ledger');
  return observeCall(body.ledger, body.call, {
    maxShortCallsPerHour: body.maxShortCallsPerHour ?? DEFAULT_SHORT_CALLS_PER_HOUR,
  });
}
