/**
 * Shared pieces of the two IAM-authorized resolver routes (/internal/resolve/number and /internal/resolve/widget).
 * Owner: issue T5 (tasks/T5.md).
 *
 * The only identity inputs are the dialed number and the widget key. Both are looked up server-side in a ROUTE item,
 * and the tenant found there is the only tenant the response and the call-scoped token ever carry. Nothing the caller,
 * the visitor or the model says (a tenant id in the body, a caller number, a room name) can change it.
 *
 * Round trips on the warm path: one consistent GetItem on the route item. The agent config comes from PROFILE.rendered*
 * through the tenant's ABAC credentials and is cached for 60 s per tenant, so a suspended number still takes effect on
 * the very next call (route item, never cached) and a prompt edit is live within a minute.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, mintTenantToken, type TenantRuntimeState, type TenantTokenClaims } from '@1145/shared';
import { HttpError, json, type HttpResult } from './http.js';

export type RuntimeState = TenantRuntimeState;

export interface Route { tid: string; state: RuntimeState }

/** Same shape as `agent` in contracts/openapi/tenant-tools.yaml#ResolvedCall. */
export interface AgentConfig {
  agentName: string; businessName: string; timezone: string; disclosureLine: string;
  instructions: string; voiceId?: string; language: string; templateVersion: string;
}

export interface TenantRuntime {
  /** Only ever 'suspended' or 'over_cap' when PROFILE says so; otherwise 'active'. Combined with the route's state. */
  state: RuntimeState;
  agent: AgentConfig;
}

export interface ResolverDeps {
  /** undefined = the number is not assigned. */
  routeForNumber(e164: string): Promise<Route | undefined>;
  /** undefined = unknown or disabled widget. */
  routeForWidget(widgetKey: string): Promise<Route | undefined>;
  /** From PROFILE.rendered*, cached 60 s per tenant. Throws 503 not_ready when the tenant has no rendered agent yet. */
  runtimeConfig(tid: string): Promise<TenantRuntime>;
  /** The CURRENT signing secret (not the previous one kept for rotation). */
  signingSecret(): Promise<string>;
}

export const E164 = /^\+[1-9]\d{6,14}$/;
/** Public by design (it identifies a tenant like a phone number does). Matches contracts/openapi/channels.yaml. */
export const WIDGET_KEY = /^wk_[A-Za-z0-9]{16,40}$/;

/** Call-scoped token lifetime (SEC-08). The worker ends every call and chat after 15 minutes (MAX_CALL_SECONDS) and never
 *  refreshes a token, so this is that plus a margin for the greeting and a slow close. A leaked token is good for minutes, not an hour. */
export const CALL_TOKEN_TTL_SECONDS = 20 * 60;
export const CONFIG_CACHE_MS = 60_000;

const DEFAULT_AGENT_NAME = 'Ava'; // same default the render step uses when the owner has not picked a name
const DEFAULT_LANGUAGE = 'en-US';

export const NOT_READY_LINE = "Sorry, we're still getting set up here. Could you try again in a few minutes?";

// ---------------------------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------------------------

const RANK: Record<RuntimeState, number> = { active: 0, over_cap: 1, suspended: 2 };
const stricter = (a: RuntimeState, b: RuntimeState): RuntimeState => (RANK[a] >= RANK[b] ? a : b);

/** A route state we do not recognise is treated as suspended: the worker then only takes a message. Missing = active. */
function parseRouteState(v: unknown): RuntimeState {
  if (v === undefined) return 'active';
  return v === 'active' || v === 'over_cap' || v === 'suspended' ? v : 'suspended';
}

type Item = Record<string, unknown>;

function toRoute(item: Item | undefined): Route | undefined {
  if (!item || typeof item.tid !== 'string' || item.tid === '') return undefined;
  return { tid: item.tid, state: parseRouteState(item.state) };
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function notReady(tid: string, why: string): HttpError {
  // The tenant id goes to the log (it is not personal data), not into the response body.
  console.warn(JSON.stringify({ level: 'warn', event: 'resolver.not_ready', tenantId: tid, why }));
  return new HttpError(503, 'not_ready', 'tenant agent is not ready', NOT_READY_LINE);
}

function toRuntime(tid: string, p: Item | undefined): TenantRuntime {
  if (!p) throw notReady(tid, 'no PROFILE item');
  const instructions = text(p.renderedInstructions);
  const disclosureLine = text(p.renderedDisclosureLine);
  const templateVersion = text(p.templateVersion);
  const businessName = text(p.businessName) ?? text(p.name);
  const timezone = text(p.timezone)?.trim();
  const missing = Object.entries({ renderedInstructions: instructions, renderedDisclosureLine: disclosureLine, templateVersion, name: businessName, timezone })
    .filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length) throw notReady(tid, `missing ${missing.join(', ')}`);
  if (!validTimezone(timezone!)) throw notReady(tid, 'invalid timezone');
  const voiceId = text(p.voiceId);
  return {
    state: p.state === 'suspended' || p.state === 'over_cap' ? p.state : 'active',
    agent: {
      agentName: text(p.agentName)?.trim() ?? DEFAULT_AGENT_NAME,
      businessName: businessName!.trim(),
      timezone: timezone!,
      disclosureLine: disclosureLine!,
      instructions: instructions!,
      ...(voiceId ? { voiceId: voiceId.trim() } : {}),
      language: text(p.language)?.trim() ?? DEFAULT_LANGUAGE,
      templateVersion: templateVersion!,
    },
  };
}

/** Per-key TTL memo. Concurrent first calls share one load, a failed load is never cached, size is bounded. */
function memoTtl<V>(load: (key: string) => Promise<V>, ttlMs: number, now: () => number, max = 500): (key: string) => Promise<V> {
  const entries = new Map<string, { exp: number; value: Promise<V> }>();
  return (key) => {
    const hit = entries.get(key);
    if (hit && hit.exp > now()) return hit.value;
    entries.delete(key);
    // exp is unknown until the load settles; Infinity lets concurrent callers join the in-flight promise.
    const entry = { exp: Number.POSITIVE_INFINITY, value: undefined as unknown as Promise<V> };
    entry.value = load(key).then(
      (v) => { entry.exp = now() + ttlMs; return v; },
      (err: unknown) => { if (entries.get(key) === entry) entries.delete(key); throw err; },
    );
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
    return entry.value;
  };
}

/** The raw reads behind ResolverDeps. Production reads DynamoDB (see ddbItemReaders); tests pass fakes. */
export interface ItemReaders {
  /** NUMBER#<e164> / ROUTE */
  numberRoute(e164: string): Promise<Item | undefined>;
  /** WIDGET#<key> / ROUTE */
  widgetRoute(widgetKey: string): Promise<Item | undefined>;
  /** TENANT#<tid> / PROFILE */
  profile(tid: string): Promise<Item | undefined>;
}

export interface ResolverPorts extends ItemReaders {
  signingSecret(): Promise<string>;
  now?(): number;
  /** Default 60 s. */
  cacheTtlMs?: number;
}

export function createResolverDeps(ports: ResolverPorts): ResolverDeps {
  const now = ports.now ?? Date.now;
  const runtime = memoTtl(async (tid) => toRuntime(tid, await ports.profile(tid)), ports.cacheTtlMs ?? CONFIG_CACHE_MS, now);
  return {
    routeForNumber: async (e164) => toRoute(await ports.numberRoute(e164)),
    routeForWidget: async (widgetKey) => {
      const item = await ports.widgetRoute(widgetKey);
      // Fail closed, and read it the same way the token endpoint does: only an explicit `enabled: true` opens a widget.
      if (item?.enabled !== true) return undefined;
      return toRoute(item);
    },
    runtimeConfig: (tid) => runtime(tid),
    signingSecret: () => ports.signingSecret(),
  };
}

/**
 * The success response shared by both routes. `route.tid` is the single source of the tenant; the token is minted
 * as a customer-agent (never anything stronger), carries the carrier caller ID only for phone calls, and is returned
 * to the worker, which keeps it out of the model's reach.
 */
export async function resolvedCall(
  deps: ResolverDeps, route: Route, who: { callId: string; channel: 'voice' | 'webchat'; caller?: string },
): Promise<HttpResult> {
  const tid = asTenantId(route.tid); // a malformed route item is a data bug: fail before any read or token
  const [runtime, secret] = await Promise.all([deps.runtimeConfig(tid), deps.signingSecret()]);
  if (!secret) throw new Error('token signing secret is empty');
  const state = stricter(route.state, runtime.state);
  // `st` carries the route state the worker is told, so the tool API can refuse booking tools for a suspended or over-cap
  // tenant even if the worker (or a leaked token) does not (SEC-08; tenant-auth.ts enforces it). TenantTokenClaims in
  // packages/shared has no `st` yet (CR T5-3), hence the wider local type.
  const claims: Omit<TenantTokenClaims, 'aud' | 'iat' | 'exp'> & { st: RuntimeState } = {
    tid, prn: 'customer-agent', cid: who.callId, ...(who.caller ? { clr: who.caller } : {}), ch: who.channel, st: state,
  };
  const token = mintTenantToken(claims, secret, CALL_TOKEN_TTL_SECONDS);
  return json(200, { tenantId: tid, token, state, agent: runtime.agent });
}

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB readers
// ---------------------------------------------------------------------------------------------------------------

/** The one DocumentClient method used, so tests can pass a recorder and need no SDK client. */
export interface DocLike { send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }> }

/** PROFILE attributes the resolver needs, and nothing else (no engine refs, no owner contact details). */
const PROFILE_ATTRIBUTES = [
  'name', 'businessName', 'timezone', 'state', 'agentName', 'voiceId', 'language',
  'templateVersion', 'renderedInstructions', 'renderedDisclosureLine',
] as const;

export interface DdbReaderOptions {
  /** Lambda execution role: may read route items only (DataStack.grantRouteRead). */
  routeDoc: DocLike;
  /** ABAC client for ONE tenant (AssumeRole with the tenant_id session tag), as ddb-repo.ts does for the tools. */
  tenantDocFor(tid: string): Promise<DocLike>;
  table: string;
}

export function ddbItemReaders(o: DdbReaderOptions): ItemReaders {
  const get = async (doc: DocLike, PK: string, SK: string, extra: Record<string, unknown> = {}) =>
    (await doc.send(new GetCommand({ TableName: o.table, Key: { PK, SK }, ...extra }))).Item;
  const projection = {
    ProjectionExpression: PROFILE_ATTRIBUTES.map((_, i) => `#a${i}`).join(', '),
    // Aliased because NAME, STATE, LANGUAGE and TIMEZONE are DynamoDB reserved words.
    ExpressionAttributeNames: Object.fromEntries(PROFILE_ATTRIBUTES.map((a, i) => [`#a${i}`, a])),
  };
  return {
    // Consistent reads: a number bound a moment ago must resolve, and a suspension must bite on the next call.
    numberRoute: async (e164) => (E164.test(e164) ? get(o.routeDoc, keys.numberRoutePk(e164), keys.routeSk(), { ConsistentRead: true }) : undefined),
    widgetRoute: async (widgetKey) => (WIDGET_KEY.test(widgetKey) ? get(o.routeDoc, `WIDGET#${widgetKey}`, keys.routeSk(), { ConsistentRead: true }) : undefined),
    profile: async (tid) => get(await o.tenantDocFor(tid), keys.tenantPk(tid), keys.profileSk(), projection),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Production wiring (Lambda only; unit tests use createResolverDeps with fakes)
// ---------------------------------------------------------------------------------------------------------------

let memo: Promise<ResolverDeps> | undefined;

export function prodResolverDeps(): Promise<ResolverDeps> {
  memo ??= buildProdDeps().catch((err: unknown) => { memo = undefined; throw err; });
  return memo;
}

async function buildProdDeps(): Promise<ResolverDeps> {
  const [{ DynamoDBClient }, { DynamoDBDocumentClient }, { tenantDocFor }, { prodDeps }] = await Promise.all([
    import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb'), import('./ddb-repo.js'), import('../deps.js'),
  ]);
  const table = process.env.TABLE_NAME ?? 't1145';
  const routeDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const auth = await prodDeps();
  return createResolverDeps({
    // `tenantDocFor` is the one ABAC provider ddb-repo.ts caches for the whole container (TenantDataRole + tenant_id session
    // tag, ~14 minutes per tenant), so reading PROFILE here costs no AssumeRole of its own (CR T5-2).
    ...ddbItemReaders({ routeDoc, tenantDocFor, table }),
    // tokenSecrets() is [tokenCurrent, tokenPrevious]; new tokens are always signed with the current one.
    signingSecret: async () => {
      const [current] = await auth.tokenSecrets();
      if (!current) throw new Error('tool-api signing secret is not configured');
      return current;
    },
  });
}
