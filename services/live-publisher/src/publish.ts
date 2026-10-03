/**
 * EventBridge -> AppSync Events. Owner: issue P6 (tasks/P6.md). Contract: contracts/realtime/channels.md.
 *
 *   tenant events            -> /tenants/<tid>/live   (tid = verified envelope tenantId, format-checked)
 *   owner web chat replies   -> /owners/<sub>/chat    (sub = Cognito sub set by the router, format-checked)
 *   tenant.state_changed     -> /ops/fleet
 *
 * Every payload has phone numbers masked and internal fields dropped. Publishing is SigV4 over the AppSync Events
 * HTTP endpoint; subscribing is authorised separately by the namespace onSubscribe handlers (realtime-stack.ts).
 * Nothing here reads a channel name from model output: the channel is derived from authenticated envelope fields.
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { maskPhone, type EventEnvelope, type EventType } from '@1145/shared';

export type Sender = (channel: string, events: string[]) => Promise<void>;
export interface PublishResult { published: boolean; channel?: string; reason?: string }

const TENANT_ID_RE = /^t_[a-z0-9]{8,40}$/;
/** Cognito `sub` is a UUID. Anything else (slashes, wildcards, dots) is refused so a channel path can't be steered. */
const COGNITO_SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TENANT_LIVE_TYPES: ReadonlySet<string> = new Set<EventType | 'transcript.partial'>([
  'call.started', 'call.ended', 'booking.created', 'booking.updated', 'booking.cancelled',
  'message.taken', 'handoff.requested', 'onboarding.status', 'conversation.message', 'transcript.partial',
]);

const MAX_EVENT_BYTES = 200_000; // AppSync Events caps one event at 240 KB.

/** Which channel an event belongs on, or null when it must not reach any client. */
export function channelFor(evt: EventEnvelope): string | null {
  const data = (evt.data ?? {}) as Record<string, unknown>;
  if (evt.type === 'conversation.message' && data.audience === 'owner_chat') {
    // Owner chat is private to one owner: never fall back to the tenant channel.
    const sub = data.ownerSub;
    return typeof sub === 'string' && COGNITO_SUB_RE.test(sub) ? `/owners/${sub.toLowerCase()}/chat` : null;
  }
  if (evt.type === 'tenant.state_changed') return '/ops/fleet';
  if (!TENANT_LIVE_TYPES.has(evt.type)) return null;
  return typeof evt.tenantId === 'string' && TENANT_ID_RE.test(evt.tenantId) ? `/tenants/${evt.tenantId}/live` : null;
}

const DROP_KEY_RE = /^(_|internal)|token|secret|password|authorization|api_?key|signature|^stripe|^(pk|sk|gsi\d*(pk|sk)?)$|^transcriptKey$|^engineConversationId$|^ownerSub$|^audience$/i;
const PHONE_KEY_RE = /phone|e164|msisdn|^caller(?!masked)|^(from|to|number)$/i;
// International (+...) and formatted US numbers inside free text. Bare digit runs are left alone (ids, epochs).
const PHONE_IN_TEXT_RE = /\+\d[\d\s().-]{5,18}\d|\(\d{3}\)[\s.-]?\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g;
const MASKED_MARK = '•';

function maskInText(s: string): string {
  return s.replace(PHONE_IN_TEXT_RE, (m) => maskPhone(m));
}

/** Drops internal fields and masks phone numbers at every depth. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (typeof value === 'string') return maskInText(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEY_RE.test(k)) continue;
      if (typeof v === 'string' && PHONE_KEY_RE.test(k) && !v.includes(MASKED_MARK) && v.replace(/\D/g, '').length >= 7) out[k] = maskPhone(v);
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function payloadFor(evt: EventEnvelope, channel: string): string {
  const body: Record<string, unknown> = {
    type: evt.type,
    version: evt.version,
    correlationId: evt.correlationId,
    occurredAt: evt.occurredAt,
    // Tenant events: the tenant is the channel. Fleet events need it to say which tenant changed.
    ...(channel === '/ops/fleet' ? { tenantId: evt.tenantId } : {}),
    data: sanitize(evt.data ?? {}),
  };
  const json = JSON.stringify(body);
  return json.length > MAX_EVENT_BYTES ? JSON.stringify({ ...body, data: { truncated: true } }) : json;
}

export async function publishEnvelope(evt: EventEnvelope, send: Sender): Promise<PublishResult> {
  const channel = channelFor(evt);
  if (!channel) return { published: false, reason: 'no_channel' };
  await send(channel, [payloadFor(evt, channel)]);
  return { published: true, channel };
}

/** Validates an EventBridge event (source 1145.*, detail-type matches the envelope) and publishes it. */
export async function handleEventBridge(event: unknown, send: Sender): Promise<PublishResult> {
  const e = event as { source?: unknown; 'detail-type'?: unknown; detail?: unknown } | null;
  if (!e || typeof e !== 'object') return { published: false, reason: 'malformed' };
  if (typeof e.source !== 'string' || !e.source.startsWith('1145.')) return { published: false, reason: 'untrusted_source' };
  const d = e.detail as Partial<EventEnvelope> | null;
  if (!d || typeof d !== 'object' || typeof d.type !== 'string' || typeof d.tenantId !== 'string' || typeof d.data !== 'object' || d.data === null) {
    return { published: false, reason: 'malformed' };
  }
  if (e['detail-type'] !== d.type) return { published: false, reason: 'type_mismatch' };
  return publishEnvelope(d as EventEnvelope, send);
}

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
export interface SignedSenderOptions {
  host: string;
  region: string;
  credentials: () => Promise<Credentials>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** SigV4-signed POST https://<host>/event {channel, events: [json strings]}. Throws on any failure so the invoke retries. */
export function signedSender(opts: SignedSenderOptions): Sender {
  const signer = new SignatureV4({ service: 'appsync', region: opts.region, credentials: opts.credentials, sha256: Sha256 });
  const doFetch = opts.fetchFn ?? fetch;
  return async (channel, events) => {
    const body = JSON.stringify({ channel, events });
    const request = {
      method: 'POST',
      protocol: 'https:',
      hostname: opts.host,
      path: '/event',
      query: {},
      headers: { host: opts.host, 'content-type': 'application/json' },
      body,
    } as Parameters<SignatureV4['sign']>[0];
    const signed = await signer.sign(request, opts.now ? { signingDate: opts.now() } : undefined);
    const res = await doFetch(`https://${opts.host}/event`, {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`appsync events publish failed: HTTP ${res.status}`);
    const result = (await res.json().catch(() => ({}))) as { failed?: unknown[] };
    if (Array.isArray(result.failed) && result.failed.length > 0) throw new Error(`appsync events publish failed for ${result.failed.length} event(s)`);
  };
}

let cachedSender: Sender | undefined;
function defaultSender(): Sender {
  if (!cachedSender) {
    const host = process.env.EVENTS_HTTP_DOMAIN;
    if (!host) throw new Error('EVENTS_HTTP_DOMAIN is not set');
    cachedSender = signedSender({ host, region: process.env.AWS_REGION ?? 'us-east-1', credentials: defaultProvider() });
  }
  return cachedSender;
}

export async function handler(event: unknown): Promise<PublishResult> {
  const result = await handleEventBridge(event, (channel, events) => defaultSender()(channel, events));
  // Log the outcome only, never the payload (it can contain customer data).
  console.log(JSON.stringify({ msg: 'live-publish', published: result.published, channel: result.channel, reason: result.reason }));
  return result;
}
