/**
 * Onboarding API: save business basics, and the core the other onboarding handlers D1 owns build on
 * (waitlist.ts, provisioning.ts): service-token auth, request helpers, the ONBOARDING# store.
 * Owner: issue D1 (tasks/D1.md). Contract: contracts/openapi/onboarding-internal.yaml.
 *
 * Who is calling and which onboarding it is about:
 * - The caller proves itself with a short-lived HS256 service token whose `onb` claim names ONE onboarding. The path
 *   id must equal that claim, so a token minted for one owner cannot read or write another owner's onboarding.
 * - Nothing in a request body is an identity. `onboardingId` comes from the path (checked against the token), and the
 *   tenant id is generated here, server-side, when provisioning starts. Owner free text is data: it is cleaned,
 *   length-capped and validated, never interpreted.
 */
import { timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { asTenantId, hmacSha256, safeEqual } from '@1145/shared';

// ---------------------------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------------------------

export interface ApiEvent {
  rawPath?: string;
  path?: string;
  pathParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
  httpMethod?: string;
}

export interface ApiResult { statusCode: number; headers: Record<string, string>; body: string }

export const json = (statusCode: number, body: unknown): ApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

/**
 * Error bodies carry `code` (what agents/common/api.py turns into the tool's error) and the same value as `error`
 * (the style parse-profile.ts uses). Success bodies never have an `error` key: the agent treats that as a failure.
 */
export const fail = (statusCode: number, code: string, message: string): ApiResult => json(statusCode, { code, error: code, message });

export const methodOf = (ev: ApiEvent): string => (ev.requestContext?.http?.method ?? ev.httpMethod ?? '').toUpperCase();

const MAX_BODY_CHARS = 8 * 1024;

export function readJsonBody(ev: ApiEvent): { ok: true; body: Record<string, unknown> } | { ok: false; response: ApiResult } {
  let raw = ev.body ?? '';
  if (raw && ev.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (!raw.trim()) return { ok: true, body: {} };
  if (raw.length > MAX_BODY_CHARS) return { ok: false, response: fail(400, 'body_too_large', 'That request is too big.') };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, response: fail(400, 'invalid_json', 'The body is not valid JSON.') }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, response: fail(400, 'invalid_json', 'The body must be a JSON object.') };
  return { ok: true, body: parsed as Record<string, unknown> };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Owner free text: control and bidi characters become spaces, whitespace collapses, length is capped. Undefined if nothing is left. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = [...v.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
  return s || undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Service token (SEC-22): HS256, audience onboarding-api, one onboarding id per token
// ---------------------------------------------------------------------------------------------------------------

export const ONBOARDING_TOKEN_AUDIENCE = 'onboarding-api';
/** Per-invocation tokens last minutes; anything that claims to live longer than this is not one of ours. */
const MAX_TOKEN_LIFETIME_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 60;
const MIN_SECRET_CHARS = 16;

export interface OnboardingTokenClaims { onb: string; aud: typeof ONBOARDING_TOKEN_AUDIENCE; iat: number; exp: number }
export class OnboardingTokenError extends Error {}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Same compact format as the tool-api token (packages/shared/src/tokens.ts) so the router and agent can mint it the same way. */
export function mintOnboardingToken(
  onboardingId: string,
  secret: string,
  ttlSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({ onb: onboardingId, aud: ONBOARDING_TOKEN_AUDIENCE, iat: nowSeconds, exp: nowSeconds + ttlSeconds });
  return `${header}.${payload}.${hmacSha256(secret, `${header}.${payload}`).toString('base64url')}`;
}

export function verifyOnboardingToken(
  token: string,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): OnboardingTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OnboardingTokenError('malformed token');
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: unknown };
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { throw new OnboardingTokenError('bad header'); }
  if (header.alg !== 'HS256') throw new OnboardingTokenError('unsupported alg');

  const given = Buffer.from(s, 'base64url');
  const signed = secrets.some((secret) => {
    const expected = hmacSha256(secret, `${h}.${p}`);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!signed) throw new OnboardingTokenError('bad signature');

  let claims: Partial<OnboardingTokenClaims>;
  try { claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw new OnboardingTokenError('bad payload'); }
  if (claims.aud !== ONBOARDING_TOKEN_AUDIENCE) throw new OnboardingTokenError('wrong audience');
  if (typeof claims.onb !== 'string' || !claims.onb) throw new OnboardingTokenError('missing onboarding claim');
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') throw new OnboardingTokenError('missing times');
  if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) throw new OnboardingTokenError('lifetime too long');
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new OnboardingTokenError('issued in the future');
  if (claims.exp <= nowSeconds) throw new OnboardingTokenError('expired');
  return claims as OnboardingTokenClaims;
}

/** Router-assigned ids look like `o_<20 chars>`. This is also what keeps an id safe as a key segment and execution name. */
export const ONBOARDING_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

const headerValue = (headers: ApiEvent['headers'], name: string): string | undefined => {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
};

/** The stack routes `/internal/onboarding/{id}/...`; the contract names it {onboardingId}. Accept both. */
function pathOnboardingId(ev: ApiEvent): string | undefined {
  const p = ev.pathParameters;
  const fromParam = p?.onboardingId ?? p?.id;
  if (fromParam) return fromParam;
  return /\/internal\/onboarding\/([^/]+)(?:\/|$)/.exec(ev.rawPath ?? ev.path ?? '')?.[1];
}

export interface CoreDeps {
  store: OnboardingStore;
  /** Current and (during rotation) previous signing keys. Never logged. */
  tokenSecrets(): Promise<readonly string[]>;
  now?: () => Date;
}

export type Authorized = { ok: true; onboardingId: string } | { ok: false; response: ApiResult };

/**
 * Order matters: no valid token -> 401 and nothing else is revealed; a valid token for another onboarding -> 403
 * before the id is used for anything.
 */
export async function authorize(ev: ApiEvent, deps: Pick<CoreDeps, 'tokenSecrets' | 'now'>): Promise<Authorized> {
  const unauthorized = (): Authorized => ({ ok: false, response: fail(401, 'unauthorized', 'Missing or invalid service token.') });
  const bearer = /^Bearer\s+(\S+)$/i.exec(headerValue(ev.headers, 'authorization') ?? '')?.[1];
  if (!bearer) return unauthorized();

  let secrets: string[];
  try {
    secrets = (await deps.tokenSecrets()).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_CHARS);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'onboarding token secrets unavailable', err: String(err) }));
    return { ok: false, response: fail(500, 'server_misconfigured', 'The service could not check credentials.') };
  }
  if (secrets.length === 0) {
    console.error(JSON.stringify({ level: 'error', msg: 'no usable onboarding token secret configured' }));
    return { ok: false, response: fail(500, 'server_misconfigured', 'The service could not check credentials.') };
  }

  let claims: OnboardingTokenClaims;
  try {
    claims = verifyOnboardingToken(bearer, secrets, Math.floor((deps.now?.() ?? new Date()).getTime() / 1000));
  } catch {
    return unauthorized();
  }

  const id = pathOnboardingId(ev);
  if (!id) return { ok: false, response: fail(400, 'missing_onboarding_id', 'The path has no onboarding id.') };
  if (!safeEqual(claims.onb, id)) return { ok: false, response: fail(403, 'forbidden', 'This token is for a different onboarding.') };
  if (!ONBOARDING_ID_RE.test(id)) return { ok: false, response: fail(400, 'invalid_onboarding_id', 'That onboarding id is not valid.') };
  return { ok: true, onboardingId: id };
}

// ---------------------------------------------------------------------------------------------------------------
// Store: ONBOARDING#<id> items (contracts/dynamodb/keys.md)
// ---------------------------------------------------------------------------------------------------------------

export interface AreaHint { areaCode?: string; state?: string }

/** ONBOARDING#<id> / STATE. The router creates it; D1 adds the attributes below with targeted updates only. */
export interface OnboardingState {
  onboardingId: string;
  /** started | provisioning | waitlisted (the router writes `started`). */
  status?: string;
  channel?: string;
  channelUserId?: string;
  /** Written by the signup callback (D4): `pending` until the owner replies YES in the chat that started signup, then `confirmed`. */
  identityStatus?: string;
  waitlisted?: boolean;
  waitlistReason?: string;
  /** Generated here, once, the first time provisioning starts. Never from a request. */
  tenantId?: string;
  provisioning?: { executionName: string; attempt: number; startedAt: string };
  [attr: string]: unknown;
}

/** ONBOARDING#<id> / BASICS: what the owner said, cleaned. `area` is what we could resolve for the number search. */
export interface StoredBasics {
  businessName: string;
  businessType: string;
  areaText: string;
  area: AreaHint;
  website?: string;
  updatedAt: string;
}

export interface WaitlistEntry { reason: string; detail?: string; at: string }

export interface OnboardingStore {
  getState(onboardingId: string): Promise<OnboardingState | undefined>;
  getBasics(onboardingId: string): Promise<StoredBasics | undefined>;
  putBasics(onboardingId: string, basics: StoredBasics): Promise<void>;
  /** Flags STATE first (so provisioning is refused at once; the first reason stays), then writes the WAITLIST item once. Repeats are harmless. */
  markWaitlisted(onboardingId: string, entry: WaitlistEntry): Promise<void>;
  /** First writer wins. Returns the tenant id of record, which may not be `candidate`. */
  ensureTenantId(onboardingId: string, candidate: string): Promise<string>;
  /** Records the current execution. Never moves the attempt backwards. */
  recordProvisioning(onboardingId: string, p: { executionName: string; attempt: number; startedAt: string }): Promise<void>;
}

/** The slice of DynamoDBDocumentClient we use, so tests can pass a recorder. */
export interface DocClient { send(command: any): Promise<any> }

const isConditionalFailure = (err: unknown) => (err as { name?: string })?.name === 'ConditionalCheckFailedException';

export function ddbOnboardingStore(doc: DocClient, table: string): OnboardingStore {
  const pk = (id: string) => {
    if (!ONBOARDING_ID_RE.test(id)) throw new Error('invalid onboardingId');
    return `ONBOARDING#${id}`;
  };
  const key = (id: string, sk: string) => ({ PK: pk(id), SK: sk });
  const strip = ({ PK: _pk, SK: _sk, ...rest }: Record<string, unknown>) => rest;

  return {
    async getState(id) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: key(id, 'STATE'), ConsistentRead: true }));
      return r.Item ? ({ onboardingId: id, ...strip(r.Item) } as OnboardingState) : undefined;
    },

    async getBasics(id) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: key(id, 'BASICS'), ConsistentRead: true }));
      if (!r.Item) return undefined;
      const { onboardingId: _id, ...rest } = strip(r.Item);
      return rest as unknown as StoredBasics;
    },

    async putBasics(id, basics) {
      await doc.send(new PutCommand({ TableName: table, Item: { ...key(id, 'BASICS'), onboardingId: id, ...basics } }));
    },

    async markWaitlisted(id, entry) {
      await doc.send(new UpdateCommand({
        TableName: table, Key: key(id, 'STATE'),
        UpdateExpression: 'SET waitlisted = :t, #st = :w, waitlistReason = if_not_exists(waitlistReason, :r), waitlistedAt = if_not_exists(waitlistedAt, :at)',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':t': true, ':w': 'waitlisted', ':r': entry.reason, ':at': entry.at },
      }));
      try {
        await doc.send(new PutCommand({
          TableName: table,
          Item: { ...key(id, 'WAITLIST'), onboardingId: id, ...entry },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      } catch (err) {
        if (!isConditionalFailure(err)) throw err; // already on the list: the first entry stays
      }
    },

    async ensureTenantId(id, candidate) {
      asTenantId(candidate);
      const r = await doc.send(new UpdateCommand({
        TableName: table, Key: key(id, 'STATE'),
        UpdateExpression: 'SET tenantId = if_not_exists(tenantId, :t)',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':t': candidate },
        ReturnValues: 'ALL_NEW',
      }));
      const tenantId = r.Attributes?.tenantId;
      if (typeof tenantId !== 'string') throw new Error('tenantId missing after update');
      return tenantId;
    },

    async recordProvisioning(id, p) {
      try {
        await doc.send(new UpdateCommand({
          TableName: table, Key: key(id, 'STATE'),
          UpdateExpression: 'SET provisioning = :p, #st = :prov',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(provisioning) OR provisioning.attempt <= :n)',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':p': p, ':n': p.attempt, ':prov': 'provisioning' },
        }));
      } catch (err) {
        if (!isConditionalFailure(err)) throw err; // a later attempt is already on record: leave it
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Area and website from owner free text
// ---------------------------------------------------------------------------------------------------------------

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));
const STATE_NAMES_LONGEST_FIRST = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length);

export const AREA_CODE_RE = /^[2-9]\d{2}$/;

/**
 * Best effort and deterministic: "Frisco, TX" -> TX, "area code 972" -> 972. A bare city ("Frisco") gives nothing, and
 * that is fine: provisioning asks for an area code instead of guessing. The state is read only from the END of the
 * text ("Kansas City" is not Kansas), and a 3-digit number is only an area code when it stands alone, sits in
 * parentheses or follows "area code" ("Highway 380" is not 380).
 */
export function parseArea(text: string): AreaHint {
  const out: AreaHint = {};
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return out;

  const code = /^\(?([2-9]\d{2})\)?$/.exec(t) ?? /\barea\s*code\s*:?\s*\(?([2-9]\d{2})\)?(?!\d)/i.exec(t) ?? /\(([2-9]\d{2})\)/.exec(t);
  if (code?.[1]) out.areaCode = code[1];

  const rest = t
    .replace(/\barea\s*code\s*:?\s*\(?[2-9]\d{2}\)?/gi, ' ')
    .replace(/\(\d{3}\)/g, ' ')
    .replace(/[\s,]*\b\d{5}(?:-\d{4})?\s*$/, '')
    .replace(/[\s,.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const comma = /,\s*([A-Za-z]{2})$/.exec(rest)?.[1]?.toUpperCase();
  const upper = /(?:^|\s)([A-Z]{2})$/.exec(rest)?.[1];
  const abbreviation = [comma, upper].find((c) => c && STATE_CODES.has(c));
  if (abbreviation) { out.state = abbreviation; return out; }

  const lower = rest.toLowerCase();
  for (const name of STATE_NAMES_LONGEST_FIRST) {
    if (lower === name || lower.endsWith(` ${name}`) || lower.endsWith(`,${name}`)) { out.state = STATE_NAMES[name]; return out; }
  }
  return out;
}

const MAX_WEBSITE_CHARS = 300;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const INTERNAL_SUFFIX = /\.(?:local|localhost|internal|lan|home|corp|intranet|arpa)$/;

/**
 * The website feeds the knowledge scraper later, so only an ordinary public http(s) address gets through: no other
 * schemes, no credentials, no IP literals, no single-label hosts, no internal suffixes. Anything else is dropped (the
 * website is optional); the scraper still re-checks every fetch and redirect (SEC-17).
 */
export function normalizeWebsite(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > MAX_WEBSITE_CHARS || /\s/.test(s)) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(?:\/|$)/.test(s); // "localhost:3000" is a host, not a scheme
  let url: URL;
  try { url = new URL(hasScheme ? s : `https://${s}`); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4.test(host) || !host.includes('.') || INTERNAL_SUFFIX.test(host)) return undefined;
  if (!/\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return undefined;
  url.hash = '';
  return url.toString();
}

// ---------------------------------------------------------------------------------------------------------------
// POST /internal/onboarding/{onboardingId}/basics
// ---------------------------------------------------------------------------------------------------------------

const MAX_NAME = 120;
const MAX_TYPE = 60;
const MAX_AREA = 100;

export function makeHandler(deps: CoreDeps) {
  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    try {
      const auth = await authorize(ev, deps);
      if (!auth.ok) return auth.response;
      if (methodOf(ev) !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');

      const state = await deps.store.getState(auth.onboardingId);
      if (!state) return fail(404, 'unknown_onboarding', 'No such onboarding.');

      const parsed = readJsonBody(ev);
      if (!parsed.ok) return parsed.response;
      const b = parsed.body;
      const businessName = cleanText(b.businessName, MAX_NAME);
      const businessType = cleanText(b.businessType, MAX_TYPE);
      const areaText = cleanText(b.area, MAX_AREA);
      if (!businessName || !businessType || !areaText) {
        return fail(400, 'invalid_basics', 'businessName, businessType and area are required.');
      }

      const area = parseArea(areaText);
      const website = normalizeWebsite(b.website);
      await deps.store.putBasics(auth.onboardingId, {
        businessName, businessType, areaText, area,
        ...(website ? { website } : {}),
        updatedAt: (deps.now?.() ?? new Date()).toISOString(),
      });
      return json(200, { saved: true, areaResolved: Boolean(area.areaCode || area.state) });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'basics failed', err: String(err) }));
      return fail(500, 'internal_error', 'Something went wrong on our side.');
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Production wiring (lazy, so importing this file from the other handlers has no side effects)
// ---------------------------------------------------------------------------------------------------------------

export const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

/** Keys in the runtime secret `1145/<stage>/runtime` (scripts/secrets/push.sh): the signing key and, during rotation, the previous one. */
export function runtimeTokenSecrets(env: NodeJS.ProcessEnv = process.env, sm: { send(cmd: any): Promise<any> } = new SecretsManagerClient({})) {
  let cache: { at: number; value: string[] } | undefined;
  return async (): Promise<string[]> => {
    if (cache && Date.now() - cache.at < 300_000) return cache.value;
    const r = await sm.send(new GetSecretValueCommand({ SecretId: required(env, 'RUNTIME_SECRET_ID') }));
    const parsed = JSON.parse(r.SecretString ?? '{}') as Record<string, unknown>;
    const value = [parsed.ONBOARDING_SERVICE_TOKEN, parsed.ONBOARDING_SERVICE_TOKEN_PREVIOUS].filter((s): s is string => typeof s === 'string' && s.length > 0);
    cache = { at: Date.now(), value };
    return value;
  };
}

export function prodCoreDeps(env: NodeJS.ProcessEnv = process.env): CoreDeps {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return { store: ddbOnboardingStore(doc, required(env, 'TABLE_NAME')), tokenSecrets: runtimeTokenSecrets(env) };
}

/** Builds the real handler on first use; a misconfigured environment becomes a logged 500, not a crash at import. */
export function lazyHandler(build: () => (event: unknown) => Promise<ApiResult>): (event: unknown) => Promise<ApiResult> {
  let inner: ((event: unknown) => Promise<ApiResult>) | undefined;
  return async (event) => {
    try {
      inner ??= build();
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'onboarding api misconfigured', err: String(err) }));
      return fail(500, 'server_misconfigured', 'The service is not set up yet.');
    }
    return inner(event);
  };
}

export const handler = lazyHandler(() => makeHandler(prodCoreDeps()));
