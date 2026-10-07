/**
 * POST /v1/webchat/token: widget key -> LiveKit room token for a text-only chat room (chat-<tid>-<uuid>).
 * Owner: issue C4 (tasks/C4.md). Contract: contracts/openapi/channels.yaml (createCustomerWebchatToken, CR E5-1).
 *
 * Public endpoint, so everything here assumes a hostile caller:
 *  - The tenant comes only from the widget key, looked up server-side (identity route WIDGET#<key>). Nothing else in the
 *    request (body fields, headers, room names) is ever read for identity.
 *  - The token joins exactly one room, cannot publish any track, cannot touch metadata or attributes, and lives 30 minutes.
 *  - The room is not created here. The signed token carries a RoomConfiguration (widget key as room metadata, dispatch of the
 *    "frontdesk" agent), so LiveKit creates the room, and starts the agent, only when a visitor actually connects. Minting
 *    a token costs nothing and leaves nothing running.
 *  - Rate limited per IP (checked first, counts every request, so guessing keys is capped too) and per widget key.
 *
 * Everything below the pure core `createWebchatToken` is production wiring (DynamoDB, Secrets Manager) kept in this file
 * because the issue owns one source file. The core takes every dependency as an argument and is tested with fakes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

// ───────────────────────────── constants and copy ─────────────────────────────

/** The LiveKit agent name the voice worker registers under (engines/livekit-agent worker.py). Same worker as phone calls. */
export const FRONTDESK_AGENT_NAME = 'frontdesk';
export const WEBCHAT_TOKEN_TTL_SECONDS = 30 * 60;

/** Same shape as the pattern in contracts/openapi/channels.yaml and engines/livekit-agent chat.py. */
const WIDGET_KEY = /^wk_[A-Za-z0-9]{16,40}$/;
/** A tenant id is safe to put in a room name only if it is a plain token. Anything else is a data fault, not a visitor error. */
const SAFE_TID = /^[A-Za-z0-9_-]{3,64}$/;

const DEFAULT_AGENT_NAME = 'Ava';
const MAX_AGENT_NAME = 30;
const MAX_BUSINESS_NAME = 80;
const MAX_BODY_CHARS = 4096;

// What a visitor can read from this endpoint. Plain words, no scripted apologies (1145-conversation-style).
export const UNKNOWN_WIDGET_LINE = "Sorry, this chat isn't set up yet. Please try again a little later.";
export const UNAVAILABLE_LINE = "Sorry, something's off on our end. Could you try again in a few minutes?";
export const RATE_LIMITED_LINE = 'Lots of chats are starting right now. Give it a minute and try again.';
const BAD_REQUEST_LINE = "Sorry, that didn't come through right. Could you try again?";
const GREETING_FALLBACK = "Hi, I'm the AI assistant here. This chat is saved so the team can follow up. What can I help with?";

/** Same words the worker says first in chat (engines/livekit-agent agent.py chat_greeting), so the widget never shows two hellos. */
function greetingFor(agentName: string, businessName: string): string {
  if (!agentName || !businessName) return GREETING_FALLBACK;
  return `Hi, this is ${agentName} at ${businessName}. I'm the AI assistant, and this chat is saved so the team can follow up. What can I help with?`;
}

// ───────────────────────────── types ─────────────────────────────

/** The slice of an API Gateway HTTP API (payload v2) event this handler reads. */
export interface WebchatEvent {
  requestContext?: { http?: { method?: string; sourceIp?: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
export interface WebchatResult { statusCode: number; headers?: Record<string, string>; body: string }

/** What the widget route knows about a tenant: enough to name the room and greet the visitor. No tenant data beyond that. */
export interface WidgetRecord { tid: string; businessName?: string; agentName?: string }
export interface LiveKitConfig { url: string; apiKey: string; apiSecret: string }

export interface RateLimitDecision { allowed: boolean; retryAfterSec: number }
export interface RateLimiter { hit(bucket: string, limit: number, windowSec: number): Promise<RateLimitDecision> }

export interface RateLimits { perIp: { limit: number; windowSec: number }; perKey: { limit: number; windowSec: number } }
/**
 * A real visitor opens the widget a handful of times at most (reload, second tab). Per IP is deliberately tight because
 * every request counts, including wrong keys. Per key bounds what a botnet can spend on one tenant's LLM budget; it is
 * generous enough for a busy small-business site.
 */
export const DEFAULT_LIMITS: RateLimits = {
  perIp: { limit: 10, windowSec: 10 * 60 },
  perKey: { limit: 120, windowSec: 10 * 60 },
};

export interface WebchatTokenDeps {
  /** Widget key -> tenant. undefined = unknown or disabled widget. The key is already format-checked. */
  lookupWidget(widgetKey: string): Promise<WidgetRecord | undefined>;
  livekit(): Promise<LiveKitConfig>;
  rateLimiter: RateLimiter;
  limits?: Partial<RateLimits>;
  newId?(): string;
}

// ───────────────────────────── the endpoint ─────────────────────────────

const CORS_HEADERS = {
  // Public endpoint called from the tenant's own website, no cookies or credentials, so any origin is fine.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
} as const;

function reply(statusCode: number, body?: unknown, extra: Record<string, string> = {}): WebchatResult {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...(body === undefined ? {} : { 'content-type': 'application/json', 'cache-control': 'no-store' }), ...extra },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}
const unavailable = () => reply(503, { error: 'unavailable', message: UNAVAILABLE_LINE });

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Names are owner-provided data: no control or bidi characters, one line, bounded. */
function cleanInline(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function toBrowserUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');
}

/** The widget key from `{ "widgetKey": "wk_..." }`, or undefined if the body is not that. Every other field is ignored. */
function widgetKeyFrom(event: WebchatEvent): string | undefined {
  if (typeof event.body !== 'string' || event.body.length === 0 || event.body.length > MAX_BODY_CHARS) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const key = (parsed as Record<string, unknown>).widgetKey;
  return typeof key === 'string' ? key : undefined;
}

export async function createWebchatToken(event: WebchatEvent, deps: WebchatTokenDeps): Promise<WebchatResult> {
  const method = (event.requestContext?.http?.method ?? '').toUpperCase();
  if (method === 'OPTIONS') return reply(204);
  if (method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS' });
  try {
    return await mint(event, deps);
  } catch (err) {
    // Lookup, secret, limiter or signing trouble: the visitor gets a plain line, the logs get the reason (never a value).
    console.error(JSON.stringify({ level: 'error', message: 'webchat token failed', error: (err as Error)?.name, detail: (err as Error)?.message }));
    return unavailable();
  }
}

async function mint(event: WebchatEvent, deps: WebchatTokenDeps): Promise<WebchatResult> {
  const limits: RateLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const rateLimited = (d: RateLimitDecision) =>
    reply(429, { error: 'rate_limited', message: RATE_LIMITED_LINE }, { 'retry-after': String(Math.max(1, Math.ceil(d.retryAfterSec))) });

  // 1. Per IP, before anything else, and for every request. The address is the one API Gateway saw, never a header the client
  //    can write (x-forwarded-for and friends). Stored hashed.
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  const ipDecision = await deps.rateLimiter.hit(`ip:${sha256(ip).slice(0, 32)}`, limits.perIp.limit, limits.perIp.windowSec);
  if (!ipDecision.allowed) return rateLimited(ipDecision);

  // 2. The body only ever supplies the widget key.
  const widgetKey = widgetKeyFrom(event);
  if (widgetKey === undefined) return reply(400, { error: 'bad_request', message: BAD_REQUEST_LINE });
  if (!WIDGET_KEY.test(widgetKey)) return reply(404, { error: 'unknown_widget', message: UNKNOWN_WIDGET_LINE });

  // 3. The tenant, server-side.
  const widget = await deps.lookupWidget(widgetKey);
  if (!widget) return reply(404, { error: 'unknown_widget', message: UNKNOWN_WIDGET_LINE });
  if (!SAFE_TID.test(widget.tid)) throw new Error('widget route has an unusable tenant id');

  // 4. Per widget key, only for keys that exist, so guessed keys cannot fill the limiter.
  const keyDecision = await deps.rateLimiter.hit(`key:${widgetKey}`, limits.perKey.limit, limits.perKey.windowSec);
  if (!keyDecision.allowed) return rateLimited(keyDecision);

  // 5. Token for one room. Room and identity names are random and unguessable; the room name carries the tenant id for
  //    humans reading logs only. The worker reads the widget key from the room metadata (CR E5-1), nothing else.
  const lk = await deps.livekit();
  const newId = deps.newId ?? randomUUID;
  const roomName = `chat-${widget.tid}-${newId()}`;
  const visitor = new AccessToken(lk.apiKey, lk.apiSecret, { identity: `visitor-${newId()}`, ttl: WEBCHAT_TOKEN_TTL_SECONDS });
  visitor.addGrant({
    roomJoin: true,
    room: roomName,
    // Text chat only: no tracks at all, so no audio, video or screen share. Chat text travels as data.
    canPublish: false,
    canSubscribe: true,
    canPublishData: true,
    // A visitor must not be able to rewrite metadata or attributes (the widget key, or anything that looks like a SIP caller).
    canUpdateOwnMetadata: false,
    roomCreate: false, roomAdmin: false, roomList: false, roomRecord: false, ingressAdmin: false,
    hidden: false, recorder: false, agent: false,
  });
  visitor.roomConfig = new RoomConfiguration({
    metadata: JSON.stringify({ widgetKey }),
    agents: [new RoomAgentDispatch({ agentName: FRONTDESK_AGENT_NAME })],
    // The visitor and the agent, plus one spare so an agent restart overlap or a handoff never locks the visitor out.
    maxParticipants: 3,
    // An abandoned room closes quickly, and a closed browser tab stops costing LLM time.
    emptyTimeout: 120,
    departureTimeout: 60,
  });
  const token = await visitor.toJwt();

  // Enough to follow a chat from a tenant's complaint to its room. No token, no visitor address.
  console.info(JSON.stringify({ level: 'info', message: 'webchat token issued', tid: widget.tid, room: roomName }));

  const agentName = cleanInline(widget.agentName, MAX_AGENT_NAME);
  const businessName = cleanInline(widget.businessName, MAX_BUSINESS_NAME);
  return reply(200, {
    url: toBrowserUrl(lk.url),
    token,
    roomName,
    agentName: agentName || DEFAULT_AGENT_NAME,
    greeting: greetingFor(agentName, businessName),
  });
}

// ───────────────────────────── rate limiters ─────────────────────────────

const windowStartSec = (nowMs: number, windowSec: number) => Math.floor(Math.floor(nowMs / 1000) / windowSec) * windowSec;

const MEMORY_MAX_BUCKETS = 10_000;
const MEMORY_SWEEP_EVERY_SEC = 60;

/**
 * Fixed-window counter in this container's memory. Cheap and always available, but each Lambda container counts alone, so
 * it is the first line, not the only one (see createDynamoRateLimiter). Bounded so a flood of distinct buckets cannot grow it.
 */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter & { size(): number } {
  const buckets = new Map<string, { windowStart: number; windowSec: number; count: number }>();
  let lastSweep = 0;
  return {
    size: () => buckets.size,
    async hit(bucket, limit, windowSec) {
      const nowSec = Math.floor(now() / 1000);
      const windowStart = windowStartSec(now(), windowSec);
      if (nowSec - lastSweep >= MEMORY_SWEEP_EVERY_SEC) {
        lastSweep = nowSec;
        for (const [k, v] of buckets) if (v.windowStart + v.windowSec <= nowSec) buckets.delete(k);
      }
      let entry = buckets.get(bucket);
      if (!entry || entry.windowStart !== windowStart) {
        entry = { windowStart, windowSec, count: 0 };
        buckets.delete(bucket);
        buckets.set(bucket, entry);
        // Over the cap: drop the oldest buckets (insertion order). Best effort by design; the shared limiter is the real one.
        for (const k of buckets.keys()) {
          if (buckets.size <= MEMORY_MAX_BUCKETS) break;
          buckets.delete(k);
        }
      }
      entry.count += 1;
      const allowed = entry.count <= limit;
      return { allowed, retryAfterSec: allowed ? 0 : windowStart + windowSec - nowSec };
    },
  };
}

/** The slice of DynamoDBDocumentClient we use, so tests can pass a fake. */
export interface DocClient { send(command: unknown): Promise<unknown> }

/**
 * Fixed-window counter in DynamoDB, one atomic ADD per hit, so every Lambda container shares the count. Items expire on
 * their own (`ttl`). Items live under RATELIMIT#, outside every tenant partition. Needs UpdateItem on that prefix
 * (contracts/CHANGE_REQUESTS/C4-1.md).
 */
export function createDynamoRateLimiter(cfg: { doc: DocClient; tableName: string; now?: () => number }): RateLimiter {
  const now = cfg.now ?? Date.now;
  return {
    async hit(bucket, limit, windowSec) {
      const windowStart = windowStartSec(now(), windowSec);
      const res = (await cfg.doc.send(new UpdateCommand({
        TableName: cfg.tableName,
        Key: { PK: `RATELIMIT#webchat#${bucket}`, SK: `W#${windowStart}` },
        UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
        // Kept an hour past the window so a slow clock or a late retry still lands on a live item.
        ExpressionAttributeValues: { ':one': 1, ':ttl': windowStart + windowSec + 3600 },
        ReturnValues: 'UPDATED_NEW',
      }))) as { Attributes?: { n?: number } };
      const count = Number(res.Attributes?.n ?? 0);
      const allowed = count <= limit;
      return { allowed, retryAfterSec: allowed ? 0 : windowStart + windowSec - Math.floor(now() / 1000) };
    },
  };
}

/**
 * Ask each limiter in order; the first denial wins and later ones are not asked. A limiter that errors is skipped (reported
 * through onError) so a hiccup in the shared store degrades to the in-memory limit instead of turning visitors away. If every
 * limiter errors, the error is thrown and the visitor gets a 503 rather than an unmetered token.
 */
export function createLayeredRateLimiter(limiters: RateLimiter[], onError?: (err: unknown) => void): RateLimiter {
  return {
    async hit(bucket, limit, windowSec) {
      let answered = 0; let lastError: unknown;
      for (const l of limiters) {
        let d: RateLimitDecision;
        try { d = await l.hit(bucket, limit, windowSec); } catch (err) { lastError = err; onError?.(err); continue; }
        answered += 1;
        if (!d.allowed) return d;
      }
      if (answered === 0 && limiters.length > 0) throw lastError;
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}

// ───────────────────────────── production wiring ─────────────────────────────

/**
 * Widget route: PK `WIDGET#<widgetKey>`, SK `ROUTE`, attributes `tid`, `enabled` (true), and `businessName` / `agentName` copied
 * for the greeting (this Lambda's role reads route items only, never TENANT# data). See contracts/CHANGE_REQUESTS/C4-1.md.
 */
export function createWidgetLookup(cfg: { doc: DocClient; tableName: string }): (widgetKey: string) => Promise<WidgetRecord | undefined> {
  return async (widgetKey) => {
    const res = (await cfg.doc.send(new GetCommand({
      TableName: cfg.tableName, ConsistentRead: true,
      Key: { PK: `WIDGET#${widgetKey}`, SK: 'ROUTE' },
    }))) as { Item?: Record<string, unknown> };
    const item = res.Item;
    // A widget is live only if its route says so. A missing flag is not "enabled".
    if (!item || item.enabled !== true || typeof item.tid !== 'string' || item.tid === '') return undefined;
    return {
      tid: item.tid,
      ...(typeof item.businessName === 'string' ? { businessName: item.businessName } : {}),
      ...(typeof item.agentName === 'string' ? { agentName: item.agentName } : {}),
    };
  };
}

const SECRET_CACHE_MS = 5 * 60_000;

/** LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the runtime secret (docs/API_KEYS.md), cached for five minutes. */
export function createLiveKitConfigProvider(cfg: { readSecret(): Promise<string>; now?: () => number }): () => Promise<LiveKitConfig> {
  const now = cfg.now ?? Date.now;
  let cached: { value: LiveKitConfig; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < SECRET_CACHE_MS) return cached.value;
    let secret: Record<string, unknown>;
    try { secret = JSON.parse(await cfg.readSecret()) as Record<string, unknown>; } catch (err) {
      // A JSON.parse error quotes the text it choked on. Never let that reach a log line.
      if (err instanceof SyntaxError) throw new Error('runtime secret is not valid JSON');
      throw err;
    }
    const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].filter((k) => typeof secret[k] !== 'string' || secret[k] === '');
    if (missing.length) throw new Error(`runtime secret is missing ${missing.join(', ')}`);
    const value = { url: secret.LIVEKIT_URL as string, apiKey: secret.LIVEKIT_API_KEY as string, apiSecret: secret.LIVEKIT_API_SECRET as string };
    cached = { value, at: now() };
    return value;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function createProdDeps(env: NodeJS.ProcessEnv = process.env): WebchatTokenDeps {
  const tableName = required(env, 'TABLE_NAME');
  const secretId = required(env, 'RUNTIME_SECRET_ID');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const sm = new SecretsManagerClient({});
  return {
    lookupWidget: createWidgetLookup({ doc, tableName }),
    livekit: createLiveKitConfigProvider({
      readSecret: async () => {
        const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
        return r.SecretString ?? '{}';
      },
    }),
    rateLimiter: createLayeredRateLimiter(
      [createMemoryRateLimiter(), createDynamoRateLimiter({ doc, tableName })],
      (err) => console.warn(JSON.stringify({ level: 'warn', message: 'shared rate limit store unavailable, using this container only', error: (err as Error)?.name })),
    ),
  };
}

let prod: WebchatTokenDeps | undefined;

export async function handler(event: WebchatEvent): Promise<WebchatResult> {
  try {
    // Built once per container so the secret cache and the in-memory limiter survive between invocations.
    prod ??= createProdDeps(process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'webchat token is not wired', detail: (err as Error)?.message }));
    return unavailable();
  }
  return createWebchatToken(event, prod);
}
