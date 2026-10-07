import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { keys, sha256Hex, type Principal, type TenantContext } from '@1145/shared';
import { parseBody, type GuardDecision, type GuardOutcome, type HttpEvent, type HttpResult, type RequestGuard } from './http.js';
import { requireTenantContext, type AuthDeps } from './tenant-auth.js';

/**
 * Rate limiting and abuse guard for the tool API (T6). One noisy tenant or a looping agent must not hurt anyone else.
 *
 * - A token bucket per tenant and principal, kept in DynamoDB under the tenant's own partition (`TENANT#<tid>` /
 *   `RATE#<principal>`), so the same ABAC role that fences every other tenant item fences these.
 * - Who is charged comes from the same verified sources as requireTenantContext (Cognito claim, engine secret + agent id,
 *   signed tenant token). Never the request body. A request nobody can identify is left to the handler's 401.
 * - Failed caller verification is limited across calls (T1's request): per tenant and caller number, and per tenant.
 * - The guard fails open. A slow or broken limiter must never be what takes a call down.
 *
 * handle() (lib/http.ts) runs the guard before every handler; handlers do not call anything in this file.
 */

// ---- token bucket ------------------------------------------------------------------------------------------------------

export interface BucketPolicy {
  /** Largest burst, in requests. */
  capacity: number;
  /** Sustained rate, in requests per second. May be below 1. */
  refillPerSec: number;
}

/** What is stored. Tokens are whole thousandths so refill math never drifts; `v` is the compare-and-set version. */
export interface BucketState { tokensMilli: number; at: number; v: number }

/** Persistence for buckets. Every call is scoped to one tenant, like every repo method (ADR-0003). */
export interface BucketStore {
  read(tenantId: string, bucket: string): Promise<BucketState | undefined>;
  /** Store `next` only if the stored version is still `prev?.v` (or nothing is stored when `prev` is undefined). */
  write(tenantId: string, bucket: string, next: BucketState, prev: BucketState | undefined, ttlEpochSec: number): Promise<boolean>;
}

export interface TakeResult {
  allowed: boolean;
  /** Whole requests left after this one. */
  remaining: number;
  /** When not allowed: seconds until `cost` tokens are back (at least 1). */
  retryAfterSec: number;
}

export interface Limiter {
  /** Spend `cost` tokens if there are that many. A refusal writes nothing, so a flood costs the store nothing. */
  take(tenantId: string, bucket: string, policy: BucketPolicy, cost?: number): Promise<TakeResult>;
  /** Would `take` succeed right now? Always reads the store, never spends. */
  peek(tenantId: string, bucket: string, policy: BucketPolicy, cost?: number): Promise<TakeResult>;
}

const MILLI = 1000;
/** Compare-and-set tries before giving up. Each lost race means another writer won, so this is only reached under a stampede. */
const MAX_ATTEMPTS = 5;
const MAX_TTL_SEC = 86_400;

function tokensAt(state: BucketState | undefined, p: BucketPolicy, nowMs: number): number {
  const cap = p.capacity * MILLI;
  if (!state) return cap;
  // elapsed ms x tokens per second = thousandths of a token
  return Math.min(cap, state.tokensMilli + Math.floor(Math.max(0, nowMs - state.at) * p.refillPerSec));
}

const retryAfter = (missingMilli: number, p: BucketPolicy): number =>
  p.refillPerSec > 0 ? Math.max(1, Math.ceil(missingMilli / p.refillPerSec / MILLI)) : MAX_TTL_SEC;

/** An idle bucket is deleted once it has refilled completely (plus a minute), which is the same as a full one. */
const ttlOf = (nowMs: number, p: BucketPolicy): number =>
  Math.ceil(nowMs / 1000 + Math.min(MAX_TTL_SEC, p.refillPerSec > 0 ? p.capacity / p.refillPerSec : MAX_TTL_SEC) + 60);

export function createLimiter(opts: { store: BucketStore; now?: () => number; maxHints?: number }): Limiter {
  const { store } = opts;
  const clock = opts.now ?? Date.now;
  const maxHints = opts.maxHints ?? 500;

  // What this container last saw of each bucket. A request then costs one conditional write and no read. A stale copy is
  // safe: the version condition fails and we re-read. A refusal from a stale copy is safe too, because the real bucket can
  // only hold fewer tokens than any copy of it (every writer subtracts, refill is a pure function of time).
  const hints = new Map<string, BucketState>();
  const remember = (key: string, s: BucketState) => {
    hints.delete(key);
    hints.set(key, s);
    if (hints.size > maxHints) hints.delete(hints.keys().next().value as string);
  };

  // Requests for one bucket queue up inside a container instead of racing each other. (Lambda runs one at a time anyway;
  // dev servers and tests do not.)
  const tails = new Map<string, Promise<void>>();
  async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = before.then(() => mine);
    tails.set(key, tail);
    await before;
    try { return await fn(); } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  return {
    take(tenantId, bucket, policy, cost = 1) {
      const key = `${tenantId}|${bucket}`;
      return serial(key, async (): Promise<TakeResult> => {
        const need = cost * MILLI;
        let state = hints.get(key);
        let loaded = state !== undefined;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!loaded) {
            state = await store.read(tenantId, bucket);
            loaded = true;
            if (state) remember(key, state);
          }
          const now = clock();
          const have = tokensAt(state, policy, now);
          if (have < need) return { allowed: false, remaining: Math.floor(have / MILLI), retryAfterSec: retryAfter(need - have, policy) };

          const next: BucketState = { tokensMilli: have - need, at: now, v: (state?.v ?? 0) + 1 };
          if (await store.write(tenantId, bucket, next, state, ttlOf(now, policy))) {
            remember(key, next);
            return { allowed: true, remaining: Math.floor(next.tokensMilli / MILLI), retryAfterSec: 0 };
          }
          hints.delete(key); // somebody else wrote first: read what they wrote and go again
          loaded = false;
        }
        // Five lost races in a row means this one bucket is being hammered right now. Refuse; do not let it through.
        return { allowed: false, remaining: 0, retryAfterSec: 1 };
      });
    },

    async peek(tenantId, bucket, policy, cost = 1) {
      const need = cost * MILLI;
      const have = tokensAt(await store.read(tenantId, bucket), policy, clock());
      return have >= need
        ? { allowed: true, remaining: Math.floor(have / MILLI), retryAfterSec: 0 }
        : { allowed: false, remaining: Math.floor(have / MILLI), retryAfterSec: retryAfter(need - have, policy) };
    },
  };
}

// ---- DynamoDB ----------------------------------------------------------------------------------------------------------

/** The slice of DynamoDBDocumentClient the adapter uses (so tests need no SDK client). */
export interface DocLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isConditionFailure = (err: unknown) => (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

/**
 * Buckets live at PK `TENANT#<tid>`, SK `RATE#...`, with `tokensMilli`, `at` (ms), `v` and a `ttl` (the table's TTL
 * attribute). `docFor(tid)` must return the ABAC-scoped client for that tenant: IAM then refuses any other partition.
 * Reads are strongly consistent; writes are conditional on the version this container last saw.
 */
export function ddbBucketStore(docFor: (tenantId: string) => Promise<DocLike>, table: string = process.env.TABLE_NAME ?? 't1145'): BucketStore {
  const keyOf = (tenantId: string, bucket: string) => {
    if (!bucket.startsWith('RATE#')) throw new Error('rate limit buckets live under RATE#');
    return { PK: keys.tenantPk(tenantId), SK: bucket };
  };
  return {
    async read(tenantId, bucket) {
      const Key = keyOf(tenantId, bucket);
      const r = await (await docFor(tenantId)).send(new GetCommand({ TableName: table, Key, ConsistentRead: true }));
      const item = r.Item as { tokensMilli?: unknown; at?: unknown; v?: unknown } | undefined;
      return item ? { tokensMilli: num(item.tokensMilli), at: num(item.at), v: num(item.v) } : undefined;
    },
    async write(tenantId, bucket, next, prev, ttl) {
      const Key = keyOf(tenantId, bucket);
      try {
        await (await docFor(tenantId)).send(new PutCommand({
          TableName: table,
          Item: { ...Key, tokensMilli: next.tokensMilli, at: next.at, v: next.v, ttl },
          ...(prev
            ? { ConditionExpression: 'v = :prev', ExpressionAttributeValues: { ':prev': prev.v } }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },
  };
}

// ---- policy ------------------------------------------------------------------------------------------------------------

export type LimitedPrincipal = 'customer-agent' | 'admin-agent' | 'owner' | 'staff';

/**
 * Per tenant, per principal. Generous on purpose: a busy front desk makes a handful of tool calls per second at most, so
 * these only bite a loop. Internal principals (ops, system) cannot call tools and are not limited.
 */
export const DEFAULT_POLICIES: Record<LimitedPrincipal, BucketPolicy> = {
  'customer-agent': { capacity: 30, refillPerSec: 5 },
  'admin-agent': { capacity: 20, refillPerSec: 2 },
  owner: { capacity: 40, refillPerSec: 5 },
  staff: { capacity: 40, refillPerSec: 5 },
};

/** The request body fields that carry a caller's answer to "who is this booking for" (T1: verification.ts). */
export const VERIFICATION_FIELDS = ['verificationCode', 'customerName', 'bookedDay'] as const;
/** The error codes T1 answers with when an answer did not match. */
export const VERIFICATION_FAILURE_CODES = ['verification_failed', 'verification_locked'] as const;

/**
 * A miss spends one token. At zero the caller can no longer try to verify, and gets a token back every ten minutes.
 * `caller` is per tenant and caller number; `tenant` backstops a guesser who rotates (spoofed) caller IDs.
 */
export const VERIFY_FAILURE_POLICIES: { caller: BucketPolicy; tenant: BucketPolicy } = {
  caller: { capacity: 8, refillPerSec: 1 / 600 },
  tenant: { capacity: 30, refillPerSec: 1 / 120 },
};

const principalBucket = (p: Principal) => `RATE#${p}`;
const TENANT_MISSES = 'RATE#vfail#tenant';
/** A hash, not the number: caller numbers do not belong in keys or logs. */
const callerMisses = (tenantId: string, e164: string) => `RATE#vfail#caller#${sha256Hex(`${tenantId}:${e164}`).slice(0, 32)}`;

// ---- what the caller hears ---------------------------------------------------------------------------------------------

/** Rotated so an agent that gets throttled twice does not hear the same sentence twice. All pass @1145/conversation-style. */
export const RATE_LIMIT_LINES = {
  customer: [
    { sayToCaller: "Sorry, I'm catching up for a second. Can you ask me again in a few seconds?" },
    { sayToCaller: 'Things are a little busy on my end right now. Give me a few seconds and try again.' },
    { sayToCaller: "Hang on, I'm a step behind. Give me a moment and ask me again." },
  ],
  owner: [
    { sayToCaller: "That's a lot at once. Give it a few seconds and try again." },
    { sayToCaller: "I'm getting requests faster than I can keep up. Try again in a moment." },
  ],
  verification: [
    { sayToCaller: "I can't pull that booking up from here, sorry. Let me take a message so the team can sort it out with you." },
    { sayToCaller: "I'm having trouble matching that booking on this call. Want me to take a message so the team can sort it out?" },
  ],
} as const;

const rotation = { customer: 0, owner: 0, verification: 0 };

function tooMany(kind: keyof typeof RATE_LIMIT_LINES, code: string, message: string, retryAfterSec: number): HttpResult {
  const lines = RATE_LIMIT_LINES[kind];
  const line = lines[rotation[kind]++ % lines.length]!;
  return {
    statusCode: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
    body: JSON.stringify({ code, message, sayToCaller: line.sayToCaller, retryAfterSec }),
  };
}

// ---- the guard ---------------------------------------------------------------------------------------------------------

export interface GuardConfig {
  limiter: Limiter;
  /** Same dependencies the handlers use to authenticate. Lazy: the guard can be built before secrets are reachable. */
  auth: () => Promise<AuthDeps>;
  policies?: Partial<Record<Principal, BucketPolicy>>;
  verifyPolicies?: { caller: BucketPolicy; tenant: BucketPolicy };
  /** Give up on the limiter after this long and let the request through. Keeps the voice path inside its budget. */
  timeoutMs?: number;
  /** How long an ElevenAgents agent id -> tenant lookup is reused, so charging a call does not add a second route read. */
  agentCacheMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 120;
const DEFAULT_AGENT_CACHE_MS = 30_000;
const ALLOW: GuardDecision = { allow: true };
/** checkAvailability is the one tool every limited principal may call, so asking "who is this?" never fails on role. */
const PROBE_TOOL = 'checkAvailability';
const TIMED_OUT = Symbol('timed out');

const defaultLog = (line: Record<string, unknown>) => (line.level === 'error' ? console.error : console.warn)(JSON.stringify(line));

async function within<T>(ms: number, work: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Does this request try to answer the verification question? Those, and only those, are held back by the miss lock. */
function carriesVerification(event: HttpEvent): boolean {
  if (!event.body) return false;
  if (event.body.length > 65_536) return true; // padding is not a way around the lock
  try {
    const body = parseBody<Record<string, unknown> | null>(event);
    if (!body || typeof body !== 'object') return false;
    return VERIFICATION_FIELDS.some((f) => body[f] !== undefined && body[f] !== null && body[f] !== '');
  } catch {
    return false;
  }
}

export function createRequestGuard(cfg: GuardConfig): RequestGuard {
  const { limiter } = cfg;
  const policies: Partial<Record<Principal, BucketPolicy>> = cfg.policies ?? DEFAULT_POLICIES;
  const vp = cfg.verifyPolicies ?? VERIFY_FAILURE_POLICIES;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agentCacheMs = cfg.agentCacheMs ?? DEFAULT_AGENT_CACHE_MS;
  const log = cfg.log ?? defaultLog;
  const agents = new Map<string, { tid: string; exp: number }>();

  /** The verified identity of the request, or undefined when it has none (the handler then answers 401 or 403 itself). */
  async function identify(event: HttpEvent): Promise<TenantContext | undefined> {
    try {
      const deps = await cfg.auth();
      return await requireTenantContext(event, PROBE_TOOL, {
        ...deps,
        tenantForEngineAgent: async (agentId) => {
          const hit = agents.get(agentId);
          if (hit && hit.exp > Date.now()) return hit.tid;
          const tid = await deps.tenantForEngineAgent(agentId);
          if (tid) {
            agents.set(agentId, { tid, exp: Date.now() + agentCacheMs });
            if (agents.size > 200) agents.delete(agents.keys().next().value as string);
          }
          return tid;
        },
      });
    } catch {
      return undefined;
    }
  }

  async function verificationLock(ctx: TenantContext): Promise<{ locked: false } | { locked: true; retryAfterSec: number }> {
    const peeks = [limiter.peek(ctx.tenantId, TENANT_MISSES, vp.tenant)];
    if (ctx.callerE164) peeks.push(limiter.peek(ctx.tenantId, callerMisses(ctx.tenantId, ctx.callerE164), vp.caller));
    const blocked = (await Promise.all(peeks)).filter((r) => !r.allowed);
    return blocked.length ? { locked: true, retryAfterSec: Math.max(...blocked.map((b) => b.retryAfterSec)) } : { locked: false };
  }

  async function recordMiss(ctx: TenantContext): Promise<void> {
    const spends = [limiter.take(ctx.tenantId, TENANT_MISSES, vp.tenant)];
    if (ctx.callerE164) spends.push(limiter.take(ctx.tenantId, callerMisses(ctx.tenantId, ctx.callerE164), vp.caller));
    await Promise.all(spends);
  }

  async function decide(event: HttpEvent): Promise<GuardDecision> {
    const ctx = await identify(event);
    const policy = ctx && policies[ctx.principal];
    if (!ctx || !policy) return ALLOW;

    const requestId = event.requestContext?.requestId;
    // Only the customer-facing agent has to verify callers, so only it is held back by the miss lock.
    const answering = ctx.principal === 'customer-agent' && carriesVerification(event);
    const [bucket, lock] = await Promise.all([
      limiter.take(ctx.tenantId, principalBucket(ctx.principal), policy),
      answering ? verificationLock(ctx) : undefined,
    ]);

    if (!bucket.allowed) {
      log({ level: 'warn', msg: 'rate limited', requestId, tenantId: ctx.tenantId, principal: ctx.principal, retryAfterSec: bucket.retryAfterSec });
      return {
        allow: false,
        response: tooMany(ctx.principal === 'customer-agent' ? 'customer' : 'owner', 'rate_limited', 'too many requests', bucket.retryAfterSec),
      };
    }
    if (lock?.locked) {
      log({ level: 'warn', msg: 'verification locked', requestId, tenantId: ctx.tenantId, principal: ctx.principal, retryAfterSec: lock.retryAfterSec });
      return { allow: false, response: tooMany('verification', 'verification_throttled', 'too many failed verification attempts', lock.retryAfterSec) };
    }

    if (ctx.principal !== 'customer-agent') return ALLOW;
    return {
      allow: true,
      settled: async (outcome: GuardOutcome) => {
        if (!outcome.code || !(VERIFICATION_FAILURE_CODES as readonly string[]).includes(outcome.code)) return;
        try {
          const r = await within(timeoutMs, () => recordMiss(ctx));
          if (r === TIMED_OUT) log({ level: 'warn', msg: 'could not record a failed verification in time', requestId, tenantId: ctx.tenantId });
        } catch (err) {
          log({ level: 'error', msg: 'could not record a failed verification', requestId, tenantId: ctx.tenantId, err: String(err) });
        }
      },
    };
  }

  return {
    async check(event) {
      const requestId = event.requestContext?.requestId;
      try {
        const r = await within(timeoutMs, () => decide(event));
        if (r === TIMED_OUT) {
          log({ level: 'warn', msg: 'rate limit check timed out, letting the request through', requestId, timeoutMs });
          return ALLOW;
        }
        return r;
      } catch (err) {
        log({ level: 'error', msg: 'rate limit check failed, letting the request through', requestId, err: String(err) });
        return ALLOW;
      }
    },
  };
}

// ---- production wiring -------------------------------------------------------------------------------------------------

export interface GuardWiring {
  auth?: () => Promise<AuthDeps>;
  docFor?: (tenantId: string) => Promise<DocLike>;
}

/**
 * ABAC-scoped DynamoDB clients, the same way lib/ddb-repo.ts builds them (createTenantDocProvider is its export).
 * TODO(CR T6-1): ddb-repo.ts keeps its provider private, so this builds a second one and a cold container pays one more
 * AssumeRole per tenant. Once T0 exports it, replace this function with that export.
 */
function prodDocFor(roleArn: string): (tenantId: string) => Promise<DocLike> {
  let provider: Promise<(tenantId: string) => Promise<DocLike>> | undefined;
  return async (tenantId) => {
    provider ??= (async () => {
      const [{ createTenantDocProvider }, { AssumeRoleCommand, STSClient }, { DynamoDBClient }, { DynamoDBDocumentClient }] = await Promise.all([
        import('./ddb-repo.js'), import('@aws-sdk/client-sts'), import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb'),
      ]);
      const sts = new STSClient({});
      return createTenantDocProvider({
        assumeRole: async (tid) => {
          const r = await sts.send(new AssumeRoleCommand({
            RoleArn: roleArn, RoleSessionName: `tenant-${tid}`.slice(0, 64), DurationSeconds: 900, // 900 s is the STS minimum
            Tags: [{ Key: 'tenant_id', Value: tid }],
          }));
          const c = r.Credentials;
          if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('assume role failed');
          return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
        },
        makeDoc: (c) => DynamoDBDocumentClient.from(new DynamoDBClient({ credentials: c }), { marshallOptions: { removeUndefinedValues: true } }),
      });
    })();
    return (await provider)(tenantId);
  };
}

/**
 * The guard every tool API Lambda runs with. It switches itself on when the function has the tenant data role (every
 * deployed one does) and stays off in unit tests and local runs. `RATE_LIMIT_DISABLED=1` is the emergency off switch.
 */
export function prodRequestGuard(env: Record<string, string | undefined> = process.env, wiring: GuardWiring = {}): RequestGuard | undefined {
  if (env.RATE_LIMIT_DISABLED === '1') return undefined;
  const roleArn = env.TENANT_DATA_ROLE_ARN;
  if (!roleArn && !wiring.docFor) return undefined;
  const docFor = wiring.docFor ?? prodDocFor(roleArn as string);
  const auth = wiring.auth ?? (async () => (await import('../deps.js')).prodDeps());
  return createRequestGuard({ limiter: createLimiter({ store: ddbBucketStore(docFor, env.TABLE_NAME ?? 't1145') }), auth });
}

/** What handle() uses when nothing else is installed. */
export const defaultRequestGuard = (): RequestGuard | undefined => prodRequestGuard();
