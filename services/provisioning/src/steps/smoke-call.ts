import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, type EngineAgentRef, type EngineId, type VoiceEngine } from '@1145/shared';
import { assertOnboardingId, awsClients, ddbTriage, emitStatus, requireEnv, statusDepsFromEnv, type DocClient, type StatusDeps, type StatusReason, type TriageCase, type TriageStore } from './emit-status.js';

export { ddbTriage, type TriageCase, type TriageStore };

/**
 * Step: smoke-call
 * Rings the owner's own phone from their new number, through VoiceEngine.placeSmokeTestCall, so the owner hears the
 * receptionist before anyone else does. It doubles as the go-live test: ActivateTenant only runs after a pass.
 *
 *   pass  = call.ended with durationSec > 10 and no error end reason
 *   miss  = anything else (never picked up, hung up at once, error, no result within the wait)
 *   retry = one more call after a short pause; two attempts is the cap, however often Step Functions re-runs this
 *   after the second miss the owner gets a plain, kind status, a triage case is opened for the support team, and the
 *   step reports `ok: false`. The line stays off; nobody is rung a third time.
 *
 * Safety (docs/security/threat-model.md SEC-19, AB-4, AB-5):
 *  - The destination is allow-listed in code: a NANP number that is not premium, toll-free, non-geographic or in a
 *    non-US/CA country, and never the tenant's own line. (The Telnyx outbound profile enforces it again at the carrier.)
 *  - Attempts are counted in DynamoDB (TENANT#<tid> / SMOKE#<onboardingId>) with a conditional write BEFORE each call,
 *    so a retried Lambda, a retried state or a replayed execution cannot ring the owner more than twice in total.
 *  - Tenant, engine, agent and numbers come from the workflow state the system wrote (D5-1), never from model output.
 *
 * How the result arrives: the voice worker (or the vendor webhook) publishes call.ended; a consumer stores it at
 * TENANT#<tid> / CALLEND#<callId> (contracts/CHANGE_REQUESTS/D8-3.md). This step reads that item, polling briefly.
 */

export const SMOKE_MIN_SECONDS = 10;
export const MAX_SMOKE_ATTEMPTS = 2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 8_000;
const MIN_ATTEMPT_TIMEOUT_MS = 15_000;
const LAMBDA_SAFETY_MS = 10_000;
const NOT_A_PASS_END_REASONS: ReadonlySet<string> = new Set(['error', 'over_cap', 'suspended']);

export interface CallOutcome { durationSec: number; endReason: string }

/** call.ended > 10 s, no error. Strictly more than ten seconds: a call that drops at ten did not prove anything. */
export function smokeCallPassed(o: CallOutcome | undefined): boolean {
  return !!o && typeof o.durationSec === 'number' && Number.isFinite(o.durationSec)
    && o.durationSec > SMOKE_MIN_SECONDS && !NOT_A_PASS_END_REASONS.has(o.endReason);
}

const NANP_RE = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/;
const BLOCKED_AREA_CODES: ReadonlySet<string> = new Set([
  '900', '976', '700', '710', '600', '622',                                   // premium and special services
  '500', '521', '522', '523', '524', '525', '526', '527', '528', '529', '533', '544', '566', '577', '588', // personal communications
  '800', '833', '844', '855', '866', '877', '888',                           // toll-free
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876', // +1 numbers outside the US and Canada
]);

/** US and Canadian geographic numbers only (territories included). Defense in depth; the carrier profile enforces it too. */
export function smokeDestinationAllowed(e164: string): boolean {
  const m = NANP_RE.exec(e164);
  if (!m) return false;
  const area = m[1]!;
  return !/^[2-9]11$/.test(area) && !BLOCKED_AREA_CODES.has(area);
}

export type SmokeFailReason = Extract<StatusReason, 'not_reached' | 'no_owner_phone' | 'owner_phone_not_allowed'>;

export interface SmokeCallInput {
  onboardingId: string;
  tenantId: string;
  /** From BindEngine: `{ number, engine, agentId }`. Written by the workflow, not by anyone typing in chat. */
  number?: { binding?: { number?: string; engine?: string; agentId?: string } };
}
export type SmokeCallResult =
  | { ok: true; attempts: number; callId: string; durationSec: number }
  | { ok: false; attempts: number; reason: SmokeFailReason };

export interface SmokeRecord { attempts: number; verdict?: 'passed' | 'failed'; reason?: SmokeFailReason; callId?: string; durationSec?: number }
export interface SmokeVerdict { verdict: 'passed' | 'failed'; reason?: SmokeFailReason; callId?: string; durationSec?: number }
export interface SmokeLedger {
  load(tenantId: string, onboardingId: string): Promise<SmokeRecord | undefined>;
  /** Counts one attempt before it is made. Resolves to the attempt number, or undefined once the cap is reached or a verdict exists. */
  reserveAttempt(tenantId: string, onboardingId: string, now: Date): Promise<number | undefined>;
  finish(tenantId: string, onboardingId: string, verdict: SmokeVerdict, now: Date): Promise<void>;
}

export interface SmokeCallDeps {
  /** The only way to place a call: through the engine interface, so it works on either engine (ADR-0001). */
  engineFor(engine: EngineId): Pick<VoiceEngine, 'placeSmokeTestCall'>;
  /** The owner's phone, from the tenant's own records. Undefined when there is none. */
  ownerPhone(tenantId: string): Promise<string | undefined>;
  outcomes: { waitForEnd(q: { tenantId: string; callId: string; timeoutMs: number }): Promise<CallOutcome | undefined> };
  ledger: SmokeLedger;
  triage: TriageStore;
  status: StatusDeps;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How long to wait for one call to end. */
  attemptTimeoutMs?: number;
  /** Pause before the second call, so the owner can find their phone. */
  retryDelayMs?: number;
}

const ENGINES: readonly EngineId[] = ['livekit-telnyx', 'elevenlabs'];
const E164_RE = /^\+[1-9]\d{6,14}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export function parseSmokeInput(input: SmokeCallInput) {
  const onboardingId = assertOnboardingId(input?.onboardingId);
  const tenantId = asTenantId(String(input?.tenantId ?? ''));
  const b = input.number?.binding;
  const engine = ENGINES.find((e) => e === b?.engine);
  if (!engine) throw new Error('smoke-call: unknown engine in the workflow state');
  if (typeof b?.agentId !== 'string' || !AGENT_ID_RE.test(b.agentId)) throw new Error('smoke-call: invalid agent id in the workflow state');
  if (typeof b.number !== 'string' || !E164_RE.test(b.number)) throw new Error('smoke-call: the bound number is not E.164');
  return { onboardingId, tenantId, engine, agentId: b.agentId, from: b.number };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Vendor errors can echo the dialed number; keep digits out of logs. */
const scrub = (err: unknown) => String(err).replace(/\+?\d[\d\s().-]{5,}\d/g, '•••').slice(0, 160);

function log(level: 'warn' | 'error', msg: string, fields: Record<string, unknown>) {
  (level === 'warn' ? console.warn : console.error)(JSON.stringify({ level, step: 'smoke-call', msg, ...fields }));
}

export async function smokeCall(input: SmokeCallInput, deps: SmokeCallDeps): Promise<SmokeCallResult> {
  const { onboardingId, tenantId, engine, agentId, from } = parseSmokeInput(input);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const voice = deps.engineFor(engine);
  const ref: EngineAgentRef = { engine, tenantId, agentId };
  /** Progress lines are nice to have: a hiccup sending one must never cost the owner the call itself. */
  const tryStatus = (reason: StatusReason | undefined, state: 'started' | 'done') =>
    emitStatus({ onboardingId, tenantId, step: 'smoke_call', state, ...(reason ? { reason } : {}) }, deps.status)
      .catch((err) => log('warn', 'status not sent', { onboardingId, err: scrub(err) }));

  // A re-run (Step Functions retry, replayed execution) gets the earlier answer and does nothing else.
  const prior = await deps.ledger.load(tenantId, onboardingId);
  if (prior?.verdict === 'passed') return { ok: true, attempts: prior.attempts, callId: prior.callId ?? 'unknown', durationSec: prior.durationSec ?? 0 };
  if (prior?.verdict === 'failed') return { ok: false, attempts: prior.attempts, reason: prior.reason ?? 'not_reached' };

  let attempts = prior?.attempts ?? 0;
  let last: { callId?: string; outcome?: CallOutcome } = {};

  /** Owner is told first, then the case is opened, then the verdict is recorded: a crash in between repeats the rest, never skips it. */
  async function fail(reason: SmokeFailReason): Promise<SmokeCallResult> {
    // This step opens its own, more detailed case below, so the generic one that a failed status would open is left out.
    await emitStatus({ onboardingId, tenantId, step: 'smoke_call', state: 'failed', reason }, { ...deps.status, triage: undefined });
    const opened = await deps.triage.open({
      tenantId, onboardingId, kind: 'smoke_call_failed', reason, attempts,
      ...(last.callId ? { lastCallId: last.callId } : {}),
      ...(last.outcome ? { lastDurationSec: last.outcome.durationSec, lastEndReason: last.outcome.endReason } : {}),
    }, now());
    if (opened) log('error', 'onboarding.needs_triage', { onboardingId, tenantId, reason, attempts }); // alarm-able, no phone numbers
    await deps.ledger.finish(tenantId, onboardingId, { verdict: 'failed', reason }, now());
    return { ok: false, attempts, reason };
  }

  const to = await deps.ownerPhone(tenantId);
  if (!to) return fail('no_owner_phone');
  if (to === from || !smokeDestinationAllowed(to)) return fail('owner_phone_not_allowed');

  for (;;) {
    const attempt = await deps.ledger.reserveAttempt(tenantId, onboardingId, now());
    if (attempt === undefined) break;
    attempts = attempt;
    if (attempt > 1) await sleep(deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    await tryStatus(attempt > 1 ? 'retry' : undefined, 'started');

    let callId: string;
    try {
      ({ callId } = await voice.placeSmokeTestCall(ref, from, to));
    } catch (err) {
      log('warn', 'call not placed', { onboardingId, attempt, err: scrub(err) });
      last = {};
      continue;
    }

    let outcome: CallOutcome | undefined;
    try {
      outcome = await deps.outcomes.waitForEnd({ tenantId, callId, timeoutMs: deps.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS });
    } catch (err) {
      log('warn', 'could not read the call result', { onboardingId, attempt, err: scrub(err) });
    }
    last = { callId, ...(outcome ? { outcome } : {}) };

    if (smokeCallPassed(outcome)) {
      await deps.ledger.finish(tenantId, onboardingId, { verdict: 'passed', callId, durationSec: outcome!.durationSec }, now());
      await tryStatus(undefined, 'done');
      return { ok: true, attempts, callId, durationSec: outcome!.durationSec };
    }
  }
  return fail('not_reached');
}

// ── DynamoDB and runtime wiring ───────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();
const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** TENANT#<tid> / SMOKE#<onboardingId>: attempts used and the final verdict. The conditional write is the cap. */
export function ddbSmokeLedger(client: DocClient, table: string): SmokeLedger {
  const key = (tenantId: string, onboardingId: string) => ({ PK: keys.tenantPk(asTenantId(tenantId)), SK: `SMOKE#${assertOnboardingId(onboardingId)}` });
  return {
    async load(tenantId, onboardingId) {
      const out = await client.send(new GetCommand({ TableName: table, Key: key(tenantId, onboardingId), ConsistentRead: true }));
      const i = out?.Item as Record<string, unknown> | undefined;
      if (!i) return undefined;
      return {
        attempts: Number(i.attempts ?? 0),
        ...(i.verdict === 'passed' || i.verdict === 'failed' ? { verdict: i.verdict } : {}),
        ...(typeof i.reason === 'string' ? { reason: i.reason as SmokeFailReason } : {}),
        ...(typeof i.callId === 'string' ? { callId: i.callId } : {}),
        ...(typeof i.durationSec === 'number' ? { durationSec: i.durationSec } : {}),
      };
    },

    async reserveAttempt(tenantId, onboardingId, now) {
      try {
        const out = await client.send(new UpdateCommand({
          TableName: table, Key: key(tenantId, onboardingId),
          UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(PK) OR ((attribute_not_exists(attempts) OR attempts < :max) AND attribute_not_exists(verdict))',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': MAX_SMOKE_ATTEMPTS, ':now': iso(now) },
          ReturnValues: 'UPDATED_NEW',
        }));
        return Number(out?.Attributes?.attempts);
      } catch (err) {
        if (isConditionFailure(err)) return undefined;
        throw err;
      }
    },

    async finish(tenantId, onboardingId, v, now) {
      const names: Record<string, string> = { '#verdict': 'verdict' };
      const values: Record<string, unknown> = { ':verdict': v.verdict, ':now': iso(now) };
      const sets = ['#verdict = :verdict', 'finishedAt = :now'];
      if (v.reason) { names['#reason'] = 'reason'; values[':reason'] = v.reason; sets.push('#reason = :reason'); }
      if (v.callId) { values[':callId'] = v.callId; sets.push('callId = :callId'); }
      if (v.durationSec !== undefined) { values[':durationSec'] = v.durationSec; sets.push('durationSec = :durationSec'); }
      await client.send(new UpdateCommand({
        TableName: table, Key: key(tenantId, onboardingId),
        UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
    },
  };
}

const CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
function parseOutcome(item: Record<string, unknown> | undefined): CallOutcome | undefined {
  if (!item || typeof item.durationSec !== 'number' || typeof item.endReason !== 'string') return undefined;
  return { durationSec: item.durationSec, endReason: item.endReason };
}

/**
 * Reads TENANT#<tid> / CALLEND#<callId>, the stored call.ended (CR D8-3), polling until it appears or the time is up.
 * The key carries the tenant from workflow state, so a call id from another tenant can never match.
 */
export function ddbCallOutcomes(
  client: DocClient, table: string,
  opts: { pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): SmokeCallDeps['outcomes'] {
  const pollMs = opts.pollMs ?? 2_000;
  const nowMs = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  return {
    async waitForEnd({ tenantId, callId, timeoutMs }) {
      const pk = keys.tenantPk(asTenantId(tenantId));
      if (!CALL_ID_RE.test(callId)) throw new Error('smoke-call: unusable call id');
      const deadline = nowMs() + timeoutMs;
      for (;;) {
        const out = await client.send(new GetCommand({ TableName: table, Key: { PK: pk, SK: `CALLEND#${callId}` }, ConsistentRead: true }));
        const found = parseOutcome(out?.Item);
        if (found) return found;
        if (nowMs() + pollMs > deadline) return undefined;
        await sleep(pollMs);
      }
    },
  };
}

/** The owner's phone: PROFILE.handoffNumber first, then the owner's MEMBER# record (CR C6-1 `phone`). */
export function ddbOwnerPhone(client: DocClient, table: string): SmokeCallDeps['ownerPhone'] {
  return async (tenantId) => {
    const pk = keys.tenantPk(asTenantId(tenantId));
    const profile = await client.send(new GetCommand({ TableName: table, Key: { PK: pk, SK: keys.profileSk() } }));
    const fromProfile = profile?.Item?.handoffNumber;
    if (typeof fromProfile === 'string' && E164_RE.test(fromProfile)) return fromProfile;

    const members = await client.send(new QueryCommand({
      TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': 'MEMBER#' }, Limit: 20,
    }));
    const owner = ((members?.Items ?? []) as Array<{ role?: unknown; phone?: unknown }>)
      .find((m) => m.role === 'owner' && typeof m.phone === 'string' && E164_RE.test(m.phone));
    return owner?.phone as string | undefined;
  };
}

/**
 * Step Functions entry. Needs a larger Lambda timeout than the 60 s default: a call rings, talks and ends, twice at
 * most (CR D8-1). The per-attempt wait shrinks to fit what is left of the invocation.
 */
export async function handler(event: SmokeCallInput, context?: { getRemainingTimeInMillis?: () => number }): Promise<SmokeCallResult> {
  parseSmokeInput(event);
  const table = requireEnv('TABLE_NAME');
  const { doc } = awsClients();
  const remaining = context?.getRemainingTimeInMillis?.();
  const attemptTimeoutMs = remaining === undefined
    ? DEFAULT_ATTEMPT_TIMEOUT_MS
    : Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(DEFAULT_ATTEMPT_TIMEOUT_MS, Math.floor((remaining - LAMBDA_SAFETY_MS - DEFAULT_RETRY_DELAY_MS) / MAX_SMOKE_ATTEMPTS)));
  return smokeCall(event, {
    engineFor: () => {
      // The VoiceEngine factory (LiveKit dial-out credentials, ElevenLabs key) is not wired into this lane yet; see CR D8-3.
      throw new Error('smoke-call: no VoiceEngine factory is wired into this Lambda yet');
    },
    ownerPhone: ddbOwnerPhone(doc, table),
    outcomes: ddbCallOutcomes(doc, table),
    ledger: ddbSmokeLedger(doc, table),
    triage: ddbTriage(doc, table),
    status: statusDepsFromEnv(),
    attemptTimeoutMs,
  });
}
