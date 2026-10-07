/**
 * GET /r/{code}: count the click once in REFCLICK#<code>, then 302 to the web onboarding start page with ?ref=<code>.
 * Owner: issue C5 (tasks/C5.md). Contract: contracts/openapi/channels.yaml (`/r/{code}`), keys: contracts/dynamodb/keys.md.
 *
 * - The destination is fixed (APP_START_URL, validated to https on 1145.ai). Nothing in the request can change it
 *   (threat model F10: no open redirect). Only the path code is read from the request, and only after the pattern check
 *   and a REFERRAL#<code> lookup. The referrer tenant is never taken from the request.
 * - An invalid or unknown code still redirects, just without ref, and writes nothing.
 * - A click counts once per visitor per code. The visitor is a random id in a first-party cookie, so the same person
 *   tapping the link again, or two taps at once, add one. IP addresses are not stored.
 * - Clicks that are not a friend do not count: the referrer opening their own link from inside the product, link-preview
 *   crawlers, scripts, and browser speculative loads. All of them still get the redirect.
 * - Storage trouble never strands the visitor. The redirect goes out either way, and the failure is logged.
 * - The click log is rate limited (SEC-25, threat model F10): per source address, in this container's memory only, and per
 *   code, in a shared hourly window. Past either limit the visitor still gets the redirect with ref; nothing is written.
 *
 * Click counts are a funnel metric. Rewards are decided elsewhere (H3: first paid invoice, one per verified tenant).
 */
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DocClient } from './lib/store.js';

export const DEFAULT_START_URL = 'https://app.1145.ai/start';

/** Same pattern as /r/{code} in contracts/openapi/channels.yaml and the code check in lib/store.ts. */
const REFERRAL_CODE = /^[A-Za-z0-9_-]{4,64}$/;
const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

const VISITOR_COOKIE = 'ref_v';
/** How long one visitor counts once for a code. Marker TTL and cookie lifetime match. */
const WINDOW_SECONDS = 30 * 24 * 3600;

/** Link-preview crawlers, search bots and scripts. "bot" is deliberately broad: missing a rare phone brand beats counting bots. */
const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp\/|curl\/|wget|python-|go-http-client|okhttp|java\/|libwww|node-fetch|undici|axios|headless|lighthouse|pingdom|uptimerobot/i;

// ───────────────────────── types ─────────────────────────

/** The parts of an API Gateway HTTP API (payload v2) event this handler reads. */
export interface ReferralEvent {
  rawPath?: string;
  pathParameters?: { code?: string };
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  /** `sourceIp` is the address API Gateway saw. It is used to rate limit in memory and never stored. */
  requestContext?: { http?: { method?: string; userAgent?: string; sourceIp?: string } };
}

export interface ReferralResponse {
  statusCode: 302;
  headers: { location: string; 'cache-control': 'no-store' };
  /** HTTP API v2 turns these into Set-Cookie headers. */
  cookies?: string[];
  body: '';
}

/** 'visit' counts. 'own' only remembers the browser as the referrer's, so it never counts later either. */
export type ClickKind = 'visit' | 'own';

export interface ReferralStore {
  /** True when REFERRAL#<code> names a referrer. */
  referralExists(code: string): Promise<boolean>;
  /** Resolves true only when this call added a click to the counter. */
  recordClick(code: string, visitorId: string, kind: ClickKind): Promise<boolean>;
}

/** Asked only for requests that would write to the click log. Resolves false to skip the write (the redirect still goes out). */
export interface ClickLimiter { allow(code: string, sourceIp: string): Promise<boolean> }

export interface ReferralDeps extends ReferralStore {
  startUrl: string;
  newVisitorId(): string;
  clickLimiter: ClickLimiter;
}

// ───────────────────────── store ─────────────────────────

const errName = (e: unknown) => (e as { name?: string })?.name;

/**
 * Items, all under PK `REFCLICK#<code>` (so one `REFCLICK#*` IAM prefix covers them):
 *   SK `COUNT`        clicks (unique visitors), firstClickAt, lastClickAt
 *   SK `V#<visitor>`  marker that this visitor is already known for the code; `ttl` = 30 days; `own: true` for the referrer's browser
 *
 * Marker first (conditional put), counter second (atomic add). Not a transaction: a transaction on one hot counter item
 * cancels concurrent writers with TransactionConflict, which would drop clicks exactly when a link takes off. If the add
 * fails after the marker is written, the marker is removed so the next click can count. A crash in between undercounts by
 * one at worst, and never double counts.
 */
export function createReferralStore(cfg: { doc: DocClient; tableName: string; now?: () => Date }): ReferralStore {
  const now = cfg.now ?? (() => new Date());
  const TableName = cfg.tableName;
  const pk = (code: string) => `REFCLICK#${code}`;

  return {
    async referralExists(code) {
      const r = (await cfg.doc.send(new GetCommand({ TableName, Key: { PK: `REFERRAL#${code}`, SK: 'OWNER' } }))) as { Item?: Record<string, unknown> };
      return typeof (r.Item?.referrerTid ?? r.Item?.tid) === 'string';
    },

    async recordClick(code, visitorId, kind) {
      const at = now();
      const marker = {
        PK: pk(code), SK: `V#${visitorId}`, at: at.toISOString(), ttl: Math.floor(at.getTime() / 1000) + WINDOW_SECONDS,
        ...(kind === 'own' ? { own: true } : {}),
      };
      try {
        await cfg.doc.send(new PutCommand({ TableName, Item: marker, ConditionExpression: 'attribute_not_exists(PK)' }));
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return false; // already known for this code
        throw err;
      }
      if (kind === 'own') return false;

      try {
        await cfg.doc.send(new UpdateCommand({
          TableName, Key: { PK: pk(code), SK: 'COUNT' },
          UpdateExpression: 'SET lastClickAt = :now, firstClickAt = if_not_exists(firstClickAt, :now) ADD clicks :one',
          ExpressionAttributeValues: { ':now': at.toISOString(), ':one': 1 },
        }));
      } catch (err) {
        await cfg.doc.send(new DeleteCommand({ TableName, Key: { PK: marker.PK, SK: marker.SK } })).catch(() => undefined);
        throw err;
      }
      return true;
    },
  };
}

// ───────────────────────── click-log limits (SEC-25) ─────────────────────────

export interface ClickLimits { perIp: { limit: number; windowSec: number }; perCode: { limit: number; windowSec: number } }

/**
 * A person opens a handful of referral links in ten minutes at most, so 10 per address is far above real use and far below a
 * script. Per code, 120 new clicks an hour is more than a small business's link gets when it is shared in a busy group chat;
 * past it the count stops climbing until the next hour, which bounds what a spread-out flood can add to one code's chart.
 */
export const DEFAULT_CLICK_LIMITS: ClickLimits = {
  perIp: { limit: 10, windowSec: 10 * 60 },
  perCode: { limit: 120, windowSec: 3600 },
};

const MAX_TRACKED_ADDRESSES = 10_000;
const RATE_KEEP_SECONDS = 3600;

const windowStartOf = (nowMs: number, windowSec: number) => Math.floor(nowMs / 1000 / windowSec) * windowSec;

/**
 * Per address: a fixed window in this container's memory, so no address is ever written anywhere. Each warm container counts on
 * its own, which is enough against one source (the stage throttle caps how many containers a flood can reach). Bounded, so a
 * spray of distinct addresses cannot grow it.
 * Per code: a shared fixed window under REFCLICK#<code> / RATE#<windowStart> (atomic ADD, ttl), inside the one IAM prefix the
 * redirect may write. Without a table (`doc` unset) only the per-address limit applies.
 */
export function createClickLimiter(cfg: { doc?: DocClient; tableName?: string; limits?: Partial<ClickLimits>; now?: () => number }): ClickLimiter & { trackedAddresses(): number } {
  const limits: ClickLimits = { ...DEFAULT_CLICK_LIMITS, ...cfg.limits };
  const now = cfg.now ?? Date.now;
  const seen = new Map<string, { windowStart: number; count: number }>();

  function allowAddress(sourceIp: string): boolean {
    const windowStart = windowStartOf(now(), limits.perIp.windowSec);
    let entry = seen.get(sourceIp);
    if (!entry || entry.windowStart !== windowStart) {
      entry = { windowStart, count: 0 };
      seen.delete(sourceIp);
      seen.set(sourceIp, entry);
      // Oldest first (insertion order). Dropping one only forgets a count, which errs toward counting a click.
      for (const k of seen.keys()) {
        if (seen.size <= MAX_TRACKED_ADDRESSES) break;
        seen.delete(k);
      }
    }
    entry.count += 1;
    return entry.count <= limits.perIp.limit;
  }

  async function allowCode(code: string): Promise<boolean> {
    if (!cfg.doc || !cfg.tableName) return true;
    const windowStart = windowStartOf(now(), limits.perCode.windowSec);
    const r = (await cfg.doc.send(new UpdateCommand({
      TableName: cfg.tableName,
      Key: { PK: `REFCLICK#${code}`, SK: `RATE#${windowStart}` },
      UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': windowStart + limits.perCode.windowSec + RATE_KEEP_SECONDS },
      ReturnValues: 'UPDATED_NEW',
    }))) as { Attributes?: { n?: unknown } };
    const n = typeof r.Attributes?.n === 'number' ? r.Attributes.n : Number.POSITIVE_INFINITY;
    return n <= limits.perCode.limit;
  }

  return {
    trackedAddresses: () => seen.size,
    // The cheap, local check first: a flood from one address never reaches the table.
    async allow(code, sourceIp) {
      return allowAddress(sourceIp) && (await allowCode(code));
    },
  };
}

// ───────────────────────── request reading ─────────────────────────

const lower = (h: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/** HTTP API v2 puts cookies in event.cookies; older payloads use the Cookie header. */
function readCookie(event: ReferralEvent, headers: Record<string, string | undefined>, name: string): string | undefined {
  const pairs = event.cookies ?? (headers.cookie ? headers.cookie.split(';') : []);
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i > 0 && pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return undefined;
}

const isOurHost = (host: string) => host === '1145.ai' || host.endsWith('.1145.ai');

/**
 * Who is this request?
 *  - skip:  a crawler, script, preview fetch or speculative load. Not a person who chose to open the link.
 *  - own:   a navigation that started on one of our own pages. The only place we show a referral link is the owner's own
 *           screen, so this is the referrer testing their link. Sec-Fetch-Site is set by the browser and cannot be set by
 *           a web page. Referer is the fallback. Faking either only removes a click, so nothing is gained by it.
 *  - visit: anyone else.
 */
function classify(event: ReferralEvent, headers: Record<string, string | undefined>): 'skip' | 'own' | 'visit' {
  const ua = event.requestContext?.http?.userAgent ?? headers['user-agent'];
  if (!ua || NOT_A_PERSON.test(ua)) return 'skip';
  if (/prefetch|prerender|preview/i.test(`${headers['sec-purpose'] ?? ''} ${headers.purpose ?? ''}`)) return 'skip';

  const site = headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'same-site') return 'own';
  if (headers.referer) {
    try {
      if (isOurHost(new URL(headers.referer).hostname)) return 'own';
    } catch { /* an unreadable Referer says nothing */ }
  }
  return 'visit';
}

// ───────────────────────── handler ─────────────────────────

const redirect = (startUrl: string, code?: string, cookies?: string[]): ReferralResponse => {
  const target = new URL(startUrl);
  if (code) target.searchParams.set('ref', code);
  return {
    statusCode: 302,
    headers: { location: target.toString(), 'cache-control': 'no-store' },
    ...(cookies?.length ? { cookies } : {}),
    body: '',
  };
};

const logError = (msg: string, err: unknown) => console.error(JSON.stringify({ level: 'error', msg, err: String(err) }));

export async function referralRedirect(event: ReferralEvent, deps: ReferralDeps): Promise<ReferralResponse> {
  const candidate = event.pathParameters?.code;
  if (!candidate || !REFERRAL_CODE.test(candidate)) return redirect(deps.startUrl);
  const code = candidate;

  let known: boolean;
  try {
    known = await deps.referralExists(code);
  } catch (err) {
    // Cannot check right now. The code is well-formed and onboarding looks the referrer up again, so keep the attribution
    // and skip the count rather than lose the visitor.
    logError('referral lookup failed', err);
    return redirect(deps.startUrl, code);
  }
  if (!known) return redirect(deps.startUrl);

  const headers = lower(event.headers);
  const kind = classify(event, headers);
  if (kind === 'skip') return redirect(deps.startUrl, code);

  // SEC-25: past a limit, or when the shared counter cannot be reached, nothing is written and no cookie is set. The visitor still
  // goes where the link points, with ref, because the count is only a funnel metric.
  let allowed: boolean;
  try {
    allowed = await deps.clickLimiter.allow(code, event.requestContext?.http?.sourceIp || 'unknown');
  } catch (err) {
    logError('referral click limit unavailable, not counting', err);
    allowed = false;
  }
  if (!allowed) return redirect(deps.startUrl, code);

  const existing = readCookie(event, headers, VISITOR_COOKIE);
  const returning = existing !== undefined && VISITOR_ID.test(existing);
  const visitorId = returning ? existing : deps.newVisitorId();

  try {
    await deps.recordClick(code, visitorId, kind);
  } catch (err) {
    logError('referral click not recorded', err);
  }

  // HttpOnly, Secure, first party, and only sent back to /r. It identifies a browser for counting and nothing else.
  const cookies = returning ? undefined : [`${VISITOR_COOKIE}=${visitorId}; Max-Age=${WINDOW_SECONDS}; Path=/r; Secure; HttpOnly; SameSite=Lax`];
  return redirect(deps.startUrl, code, cookies);
}

// ───────────────────────── wiring ─────────────────────────

/** The start URL comes from deploy config, never the request. Anything but https on 1145.ai falls back to production. */
export function resolveStartUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_START_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !isOurHost(u.hostname) || u.username || u.password || u.port) throw new Error('not an https 1145.ai URL');
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (err) {
    logError('APP_START_URL ignored, using the default', err);
    return DEFAULT_START_URL;
  }
}

export function createProdDeps(env: NodeJS.ProcessEnv = process.env): ReferralDeps {
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('missing env TABLE_NAME');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    ...createReferralStore({ doc, tableName }),
    startUrl: resolveStartUrl(env.APP_START_URL),
    newVisitorId: () => randomBytes(16).toString('base64url'),
    // Built once per container (deps are cached below), so the per-address counts last as long as the container does.
    clickLimiter: createClickLimiter({ doc, tableName }),
  };
}

let deps: ReferralDeps | undefined;
export const handler = async (event: ReferralEvent) => referralRedirect(event, (deps ??= createProdDeps()));
