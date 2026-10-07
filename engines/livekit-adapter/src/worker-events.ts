import {
  asTenantId, TokenError, verifyTenantToken,
  type NormalizedCallEvent, type TenantId, type TenantTokenClaims,
} from '@1145/shared';
import { UnsupportedEventError, WorkerEventAuthError, WorkerEventError } from './errors.js';
import type { WebhookVerifier } from './ports.js';

/**
 * Events from our own frontdesk worker, verified with a 1145 service token (packages/shared `verifyTenantToken`).
 *
 * Wire format: the envelope `engines/livekit-agent/src/frontdesk/events.py` publishes
 * (`{ type, version, tenantId?, correlationId, occurredAt, data }`) as the POST body, and
 * `Authorization: Bearer <token>` where the token is the call-scoped one the resolver minted for the worker
 * (`prn: customer-agent`, `cid` = call id) or a `system` service token.
 *
 * The tenant is the token's `tid`. A tenant id in the body is never trusted: if present it must equal the token's, and
 * a call-scoped token can only report on its own call. The body is not read until the token has verified.
 */
const MAPPED = ['call.started', 'call.ended', 'transcript.partial'] as const;
type Mapped = (typeof MAPPED)[number];
const ALLOWED_PRINCIPALS: ReadonlySet<string> = new Set(['customer-agent', 'system']);
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;
const JWT_SHAPE_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const ROLES = new Set(['agent', 'caller']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);

export interface WorkerEventEnv {
  tokenSecrets(): Promise<readonly string[]>;
  now: () => Date;
  webhooks?: WebhookVerifier;
}

type Turn = { role: 'agent' | 'caller'; text: string; atSec: number };
type Json = Record<string, unknown>;

export function workerEventVerifier(env: WorkerEventEnv) {
  return async function verifyWorkerEvent(rawBody: string, headers: Record<string, string | undefined>): Promise<NormalizedCallEvent> {
    const auth = headerValue(headers, 'authorization');
    const bearer = auth ? BEARER_RE.exec(auth) : null;

    if (!bearer) {
      // LiveKit's own webhooks carry the bare JWT (no "Bearer"). Verify, then acknowledge: the worker reports its own calls.
      if (auth && env.webhooks && JWT_SHAPE_RE.test(auth.trim())) return acknowledgeLiveKitWebhook(env.webhooks, rawBody, auth.trim());
      throw new WorkerEventAuthError('missing service token');
    }

    const claims = await verifyToken(bearer[1]!, env);
    return map(rawBody, claims, env.now);
  };
}

async function verifyToken(token: string, env: WorkerEventEnv): Promise<TenantTokenClaims & { tid: TenantId }> {
  const secrets = await env.tokenSecrets();          // a secrets outage is a server error, not a 401
  let claims: TenantTokenClaims;
  try {
    claims = verifyTenantToken(token, secrets, Math.floor(env.now().getTime() / 1000));
  } catch (err) {
    if (err instanceof TokenError) throw new WorkerEventAuthError(`invalid service token: ${err.message}`);
    throw err;
  }
  if (!ALLOWED_PRINCIPALS.has(claims.prn)) throw new WorkerEventAuthError(`service token principal ${claims.prn} may not post call events`);
  let tid: TenantId;
  try { tid = asTenantId(claims.tid); } catch { throw new WorkerEventAuthError('service token has no valid tenant'); }
  return { ...claims, tid };
}

function map(rawBody: string, claims: TenantTokenClaims & { tid: TenantId }, now: () => Date): NormalizedCallEvent {
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { throw new WorkerEventError('event body is not JSON'); }
  if (!isObject(body)) throw new WorkerEventError('event body is not an object');

  const type = body.type;
  if (typeof type !== 'string') throw new WorkerEventError('event has no type');
  if (!(MAPPED as readonly string[]).includes(type)) throw new UnsupportedEventError(type);

  if (body.tenantId !== undefined && body.tenantId !== claims.tid) {
    throw new WorkerEventAuthError('event tenant does not match the service token');
  }
  const data = body.data;
  if (!isObject(data)) throw new WorkerEventError('event has no data');
  const callId = data.callId;
  if (typeof callId !== 'string' || callId === '' || callId.length > 256) throw new WorkerEventError('event has no call id');
  if (claims.prn === 'customer-agent' && !claims.cid) throw new WorkerEventAuthError('call token carries no call id');
  if (claims.cid !== undefined && claims.cid !== callId) throw new WorkerEventAuthError('service token is for a different call');

  const event: NormalizedCallEvent = {
    type: type as Mapped,
    engine: 'livekit-telnyx',
    tenantId: claims.tid,
    callId,
    occurredAt: occurredAt(body.occurredAt, now),
    raw: data,
  };

  if (type === 'call.ended') {
    const d = data.durationSec;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) throw new WorkerEventError('call.ended has no valid durationSec');
    event.durationSec = d;
    const transcript = turns(data.transcript);
    if (transcript) event.transcript = transcript;
    const analysis = analysisOf(data.analysis);
    if (analysis) event.analysis = analysis;
  } else if (type === 'transcript.partial') {
    const turn = turnOf(data);
    if (!turn) throw new WorkerEventError('transcript.partial needs role, text and atSec');
    event.transcript = [turn];
  }
  return event;
}

async function acknowledgeLiveKitWebhook(webhooks: WebhookVerifier, rawBody: string, jwt: string): Promise<never> {
  let received: { event: string };
  try { received = await webhooks.receive(rawBody, jwt); } catch { throw new WorkerEventAuthError('invalid livekit webhook signature'); }
  throw new UnsupportedEventError(received.event || 'unknown');
}

function turnOf(v: unknown): Turn | undefined {
  if (!isObject(v)) return undefined;
  const { role, text, atSec } = v;
  if (typeof role !== 'string' || !ROLES.has(role) || typeof text !== 'string') return undefined;
  if (typeof atSec !== 'number' || !Number.isFinite(atSec) || atSec < 0) return undefined;
  return { role: role as Turn['role'], text, atSec };
}

/** All-or-nothing: a half-valid transcript would silently drop turns. */
function turns(v: unknown): Turn[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Turn[] = [];
  for (const item of v) {
    const t = turnOf(item);
    if (!t) return undefined;
    out.push(t);
  }
  return out;
}

function analysisOf(v: unknown): NonNullable<NormalizedCallEvent['analysis']> | undefined {
  if (!isObject(v)) return undefined;
  const out: NonNullable<NormalizedCallEvent['analysis']> = {};
  if (typeof v.summary === 'string') out.summary = v.summary;
  if (typeof v.sentiment === 'string' && SENTIMENTS.has(v.sentiment)) out.sentiment = v.sentiment as 'positive' | 'neutral' | 'negative';
  return Object.keys(out).length ? out : undefined;
}

function occurredAt(v: unknown, now: () => Date): string {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return now().toISOString();
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
