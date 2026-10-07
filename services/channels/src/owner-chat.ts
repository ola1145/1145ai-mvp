/**
 * POST /v1/owner-chat/messages (Cognito): enqueue to FIFO; replies are published to /owners/<sub>/chat.
 * Owner: issue C3 (tasks/C3.md). Contract: contracts/openapi/channels.yaml.
 *
 * The signed-in owner's web chat. This handler does the minimum before answering 202: check who is asking, check the
 * request, put one message on the inbound FIFO queue. The router (router-worker.ts) picks it up, runs the onboarding or
 * admin agent, and publishes the reply to the owner's AppSync Events channel. Nothing slow happens on this path: no
 * agent call, no database read, no secret lookup.
 *
 * Identity: the Cognito `sub` comes from the API Gateway JWT authorizer and nowhere else. The body is never trusted for
 * who is writing, which channel it is, or which tenant it belongs to. The router resolves the tenant from the
 * IDENTITY#webchat#<sub> route (tenant isolation, ADR-0003).
 */
import { createHash } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { InboundMessage } from './lib/types.js';

// ───────────────────────── request shape ─────────────────────────

/** API Gateway HTTP API (payload v2) event, with only the parts this handler reads. */
export interface OwnerChatEvent {
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { requestId: string; authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
}

export interface OwnerChatResult { statusCode: number; headers: Record<string, string>; body: string }

export interface OwnerChatDeps {
  /** Put one verified message on the inbound FIFO queue. Rejects if it could not be queued. */
  enqueue(msg: InboundMessage): Promise<void>;
  now?(): Date;
}

/** Same limits as POST /v1/owner-chat/messages in contracts/openapi/channels.yaml. */
const MAX_TEXT_CHARS = 4000;
const MAX_CLIENT_MESSAGE_ID_CHARS = 64;
const REFERRAL_CODE = /^[A-Za-z0-9_-]{4,64}$/;
/** 4000 characters of JSON-escaped emoji is about 48 KB; anything past this is not a chat message. */
const MAX_BODY_CHARS = 96 * 1024;

/** Cognito `sub` is a UUID. Anything else could steer the queue group or the reply channel path. */
const COGNITO_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Visible characters only: this id is the dedup key and is echoed back to the same owner as `inReplyTo`. */
const CLIENT_MESSAGE_ID = /^[^\s\p{Cc}]+$/u;

// ───────────────────────── what the owner reads ─────────────────────────

/**
 * Failures the web app can show as they are. Every line follows 1145-conversation-style: short, plain, no scripted
 * apology, one ask at most. `code` is for the app's logic, `messageForOwner` is for the owner's eyes.
 */
export const OWNER_CHAT_ERRORS = {
  unauthorized: { status: 401, messageForOwner: "Looks like you've been signed out. Sign in again and we'll pick up right where we left off." },
  bad_request: { status: 400, messageForOwner: "That message didn't come through properly. Could you send it again?" },
  empty_text: { status: 400, messageForOwner: 'That one came through empty. Type your message and send it again.' },
  text_too_long: { status: 400, messageForOwner: "That's a bit long for one message. Could you split it into two?" },
  invalid_client_message_id: { status: 400, messageForOwner: 'Something went sideways with that message on this page. Refresh and send it again.' },
  invalid_referral_code: { status: 400, messageForOwner: "That invite code doesn't look right. Double-check the link you were sent and try again." },
  too_large: { status: 413, messageForOwner: "That's too much to send in one go. Could you trim it down a bit?" },
  unavailable: { status: 503, messageForOwner: "I couldn't get that through just now. Give it a moment and send it again." },
  internal: { status: 500, messageForOwner: 'Something broke on my end. Give it a minute and try again.' },
} as const satisfies Record<string, { status: number; messageForOwner: string }>;

export type OwnerChatErrorCode = keyof typeof OWNER_CHAT_ERRORS;

class Rejection extends Error {
  constructor(readonly code: OwnerChatErrorCode) { super(code); }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

function fail(code: OwnerChatErrorCode, extraHeaders: Record<string, string> = {}): OwnerChatResult {
  const { status, messageForOwner } = OWNER_CHAT_ERRORS[code];
  return { statusCode: status, headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify({ code, messageForOwner }) };
}

const accepted = (clientMessageId: string): OwnerChatResult =>
  ({ statusCode: 202, headers: { ...JSON_HEADERS }, body: JSON.stringify({ accepted: true, clientMessageId }) });

/** Owner free text and the sub stay out of logs: request id and the error are enough to trace a failure. */
function logError(message: string, event: OwnerChatEvent, err: unknown): void {
  console.error(JSON.stringify({ level: 'error', message, requestId: event.requestContext?.requestId, err: String(err) }));
}

// ───────────────────────── parsing ─────────────────────────

/** The one source of identity: the verified JWT claims the authorizer attached. Fails closed. */
function subFromClaims(event: OwnerChatEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || !COGNITO_SUB.test(sub)) throw new Rejection('unauthorized');
  return sub;
}

/**
 * First name for the agent to use, from the sign-in profile (Google via Cognito), not from the body. Whatever the
 * profile says is untrusted text, so keep one short word made of letters only.
 */
function firstNameFromClaims(event: OwnerChatEvent): string | undefined {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  for (const key of ['given_name', 'name']) {
    const raw = claims[key];
    if (typeof raw !== 'string') continue;
    const word = (raw.trim().split(/\s+/)[0] ?? '').replace(/[^\p{L}\p{M}'.-]/gu, '').slice(0, 40);
    if (/\p{L}/u.test(word)) return word;
  }
  return undefined;
}

interface OwnerChatRequest { text: string; clientMessageId: string; referralCode?: string }

function parseRequest(event: OwnerChatEvent): OwnerChatRequest {
  if (!event.body) throw new Rejection('bad_request');
  if (event.body.length > MAX_BODY_CHARS) throw new Rejection('too_large');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Rejection('bad_request'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Rejection('bad_request');
  const body = parsed as Record<string, unknown>;

  const { text, clientMessageId, referralCode } = body;
  if (typeof text !== 'string' || !text.trim()) throw new Rejection('empty_text');
  if ([...text].length > MAX_TEXT_CHARS) throw new Rejection('text_too_long');
  if (typeof clientMessageId !== 'string' || [...clientMessageId].length > MAX_CLIENT_MESSAGE_ID_CHARS || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
    throw new Rejection('invalid_client_message_id');
  }
  if (referralCode !== undefined && referralCode !== null && (typeof referralCode !== 'string' || !REFERRAL_CODE.test(referralCode))) {
    throw new Rejection('invalid_referral_code');
  }
  return { text: text.trim(), clientMessageId, ...(typeof referralCode === 'string' ? { referralCode } : {}) };
}

// ───────────────────────── queue ─────────────────────────

/**
 * FIFO routing for any inbound message. Group = <channel>:<channelUserId>, so one owner's messages stay in order
 * (webchat:<sub> here). Dedup = a hash of who + which message, so a retried POST with the same clientMessageId is
 * dropped by the queue itself (5 minute window) and, after that, by the router's own per-message claim.
 * Hashing keeps the id inside the 128 character, limited-alphabet rule whatever the client sent.
 */
export function fifoParams(msg: Pick<InboundMessage, 'channel' | 'channelUserId' | 'channelMessageId'>): { groupId: string; dedupId: string } {
  return {
    groupId: `${msg.channel}:${msg.channelUserId}`,
    dedupId: createHash('sha256').update(`${msg.channel}\n${msg.channelUserId}\n${msg.channelMessageId}`).digest('hex'),
  };
}

/** The slice of SQSClient used here, so tests can pass a fake. */
export interface SqsLike {
  send(command: SendMessageCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface SqsEnqueuerConfig {
  client: SqsLike;
  queueUrl: string;
  /** Hard stop for one send. A slow queue becomes a clear 503 the app can retry, not a hung request. Default 2.5 s. */
  timeoutMs?: number;
}

export const DEFAULT_ENQUEUE_TIMEOUT_MS = 2500;

export function createSqsEnqueuer(cfg: SqsEnqueuerConfig): OwnerChatDeps['enqueue'] {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;
  return async (msg) => {
    const { groupId, dedupId } = fifoParams(msg);
    const command = new SendMessageCommand({
      QueueUrl: cfg.queueUrl, MessageBody: JSON.stringify(msg), MessageGroupId: groupId, MessageDeduplicationId: dedupId,
    });
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(`enqueue timed out after ${timeoutMs} ms`)); }, timeoutMs);
    });
    try {
      // Race as well as abort: a client that ignores the signal still cannot hold the request past the deadline.
      await Promise.race([cfg.client.send(command, { abortSignal: abort.signal }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

// ───────────────────────── handler ─────────────────────────

export async function ownerChat(event: OwnerChatEvent, deps: OwnerChatDeps): Promise<OwnerChatResult> {
  try {
    // Who first, so an unauthenticated caller learns nothing about what a valid request looks like.
    const sub = subFromClaims(event);
    const req = parseRequest(event);
    const displayName = firstNameFromClaims(event);
    const msg: InboundMessage = {
      channel: 'webchat', channelUserId: sub, chatId: sub, channelMessageId: req.clientMessageId, text: req.text,
      ...(displayName ? { displayName } : {}),
      ...(req.referralCode ? { referralCode: req.referralCode } : {}),
      receivedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    try {
      await deps.enqueue(msg);
    } catch (err) {
      // Safe for the app to retry as is: the same clientMessageId is deduplicated.
      logError('owner chat enqueue failed', event, err);
      return fail('unavailable', { 'retry-after': '1' });
    }
    return accepted(req.clientMessageId);
  } catch (err) {
    if (err instanceof Rejection) return fail(err.code);
    logError('owner chat failed', event, err);
    return fail('internal');
  }
}

function createProdDeps(env: NodeJS.ProcessEnv = process.env): OwnerChatDeps {
  const queueUrl = env.QUEUE_URL;
  if (!queueUrl) throw new Error('missing env QUEUE_URL');
  // One retry on a transient error is all the 300 ms budget allows; the app retries the rest.
  const client = new SQSClient({ maxAttempts: 2 }) as unknown as SqsLike;
  return { enqueue: createSqsEnqueuer({ client, queueUrl }) };
}

let prod: OwnerChatDeps | undefined;
export const handler = async (event: OwnerChatEvent): Promise<OwnerChatResult> => {
  try {
    prod ??= createProdDeps();
  } catch (err) {
    logError('owner chat is not configured', event, err);
    return fail('internal');
  }
  return ownerChat(event, prod);
};
