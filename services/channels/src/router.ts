import { mintTenantToken } from '@1145/shared';
import type { InboundMessage } from './lib/types.js';
import { HOLDING_LINES, PAUSED_LINE, SNAG_LINES, pickLine } from './lib/copy.js';

export interface IdentityRoute {
  role: 'owner' | 'staff' | 'onboarding';
  tid?: string;              // set once the identity is bound to an ACTIVE tenant
  onboardingId?: string;     // set while onboarding
  tenantState?: 'provisioning' | 'active' | 'suspended';
}

/**
 * Where a reply goes. All of it comes from the verified inbound message. `channelMessageId` is what web chat echoes back as
 * `inReplyTo` so the app can tie a reply to the message that caused it (CR C3-2).
 */
export type ReplyTarget = Pick<InboundMessage, 'channel' | 'channelUserId' | 'chatId' | 'channelMessageId'>;

/** What the owner's plain YES / NO to a pending identity binding turned into. Mirrors `BindingAnswer` in services/provisioning (D4). */
export type BindingAnswer =
  | { handled: false }
  | { handled: true; outcome: 'confirmed' | 'cancelled' | 'expired'; reply: string };

export interface RouterDeps {
  lookupIdentity(channel: string, channelUserId: string): Promise<IdentityRoute | undefined>;
  startOnboarding(msg: InboundMessage): Promise<string>;              // creates ONBOARDING record + IDENTITY route; returns onboardingId
  /**
   * SEC-20: the owner's YES / NO to "someone just signed in as ... if that was you, reply YES" is answered in code, before
   * any agent runs. The input comes from the identity route (onboardingId) and the verified message (channel, sender,
   * text); `{ handled: false }` means "not an answer to a pending binding, carry on". Rejects when the binding cannot be
   * read, and the router then retries the message instead of handing the YES to the model.
   * Optional only so fakes that never reach a binding need not declare it; `createProdDeps` is typed to always provide it
   * (`ProdRouterDeps`), so the deployed router cannot lose this step without a compile error.
   */
  answerPendingBinding?(input: { onboardingId: string; channel: string; channelUserId: string; text: string }): Promise<BindingAnswer>;
  invokeAgent(agent: 'onboarding' | 'admin', sessionId: string, payload: AgentPayload): Promise<string>;
  /** POST /v1/admin/changes/apply with an OWNER token. Deterministic: the LLM is not in this path. */
  applyChange(code: string, ownerToken: string): Promise<{ ok: boolean; message: string }>;
  /** Deliver a reply to the sender of a verified inbound message. The target comes from the message, never from agent output. */
  send(to: ReplyTarget, text: string): Promise<void>;
  signingSecret(): Promise<string>;
  /**
   * Idempotency per inbound message: a replayed webhook or an SQS redelivery must not invoke an agent twice.
   * claimMessage -> false means "already handled, or being handled right now". completeMessage marks it done after the
   * reply went out; releaseMessage frees it when delivery failed so the queue retry can run it again.
   */
  claimMessage(msg: InboundMessage): Promise<boolean>;
  completeMessage(msg: InboundMessage): Promise<void>;
  releaseMessage(msg: InboundMessage): Promise<void>;
}

/** What the AgentCore runtime receives. Tenant/onboarding ids come from the route, never from message text. */
export interface AgentPayload {
  text: string;
  channel: InboundMessage['channel'];
  displayName?: string;
  onboardingId?: string;
  tenantToken?: string;      // admin agent: used by its tools, never placed in the prompt
}

export interface RouteOptions {
  /** After this long without an agent reply, send a short holding line, then still deliver the real reply. Default 25 s. */
  holdingAfterMs?: number;
}

export type RouteResult = { agent: 'onboarding' | 'admin' | 'none'; sessionId: string };

export const DEFAULT_HOLDING_AFTER_MS = 25_000;

const CONFIRM_RE = /^\s*confirm\s+(\d{4})\s*$/i;

const target = (msg: InboundMessage): ReplyTarget => ({
  channel: msg.channel, channelUserId: msg.channelUserId, chatId: msg.chatId, channelMessageId: msg.channelMessageId,
});

function log(level: 'warn' | 'error', message: string, err?: unknown) {
  console.error(JSON.stringify({ level, message, err: err === undefined ? undefined : String(err) }));
}

/** Run the agent; if it is slow, say so once in a human way, then still deliver the real answer afterwards, in order. */
async function withHoldingLine(work: Promise<string>, afterMs: number, hold: () => Promise<void>): Promise<string> {
  let holding: Promise<void> | undefined;
  const timer = setTimeout(() => { holding = hold().catch((err) => log('warn', 'holding line failed', err)); }, afterMs);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    await holding;
  }
}

export async function routeInbound(msg: InboundMessage, deps: RouterDeps, opts: RouteOptions = {}): Promise<RouteResult> {
  // One agent invocation per message id, however many times the webhook or the queue delivers it.
  if (!(await deps.claimMessage(msg))) return { agent: 'none', sessionId: 'duplicate' };
  try {
    const result = await handle(msg, deps, opts);
    await deps.completeMessage(msg);
    return result;
  } catch (err) {
    await deps.releaseMessage(msg).catch((e) => log('error', 'release failed', e));
    throw err;
  }
}

async function converse(
  msg: InboundMessage, deps: RouterDeps, opts: RouteOptions,
  agent: 'onboarding' | 'admin', sessionId: string, payload: AgentPayload,
): Promise<RouteResult> {
  const to = target(msg);
  let reply: string;
  try {
    reply = await withHoldingLine(
      deps.invokeAgent(agent, sessionId, payload),
      opts.holdingAfterMs ?? DEFAULT_HOLDING_AFTER_MS,
      () => deps.send(to, pickLine(HOLDING_LINES, msg.channelMessageId)),
    );
  } catch (err) {
    // Do not let the queue retry into a second agent run: tell them plainly and let them resend.
    log('error', 'agent invocation failed', err);
    reply = pickLine(SNAG_LINES, msg.channelMessageId);
  }
  await deps.send(to, reply);
  return { agent, sessionId };
}

async function handle(msg: InboundMessage, deps: RouterDeps, opts: RouteOptions): Promise<RouteResult> {
  const route = await deps.lookupIdentity(msg.channel, msg.channelUserId);

  if (route?.tid && route.tenantState === 'active' && (route.role === 'owner' || route.role === 'staff')) {
    // "Confirm before any change": the admin agent can only PROPOSE. The owner's own reply, from the channel
    // identity bound at signup, applies it. Only owners can confirm; staff get the agent.
    const confirm = CONFIRM_RE.exec(msg.text);
    if (confirm?.[1] && route.role === 'owner') {
      const ownerToken = mintTenantToken({ tid: route.tid, prn: 'owner', ch: msg.channel, cid: msg.channelMessageId }, await deps.signingSecret(), 120);
      const r = await deps.applyChange(confirm[1], ownerToken);
      await deps.send(target(msg), r.message);
      return { agent: 'admin', sessionId: 'confirm' };
    }
    const token = mintTenantToken({ tid: route.tid, prn: 'admin-agent', ch: msg.channel, cid: msg.channelMessageId }, await deps.signingSecret(), 900);
    const sessionId = `admin-${route.tid}-${msg.channel}-${msg.channelUserId}`;
    return converse(msg, deps, opts, 'admin', sessionId, { text: msg.text, channel: msg.channel, displayName: msg.displayName, tenantToken: token });
  }

  if (route?.tenantState === 'suspended') {
    await deps.send(target(msg), PAUSED_LINE);
    return { agent: 'admin', sessionId: 'suspended' };
  }

  // SEC-20: a plain YES / NO from the chat that asked for a sign-in link answers the pending identity binding. Deterministic and
  // before any agent: the onboarding id is the route's (never the message's), and the model never sees that YES. If the binding
  // cannot be read this throws, so the message is retried and a YES is never quietly handed to the model.
  if (route?.role === 'onboarding' && route.onboardingId) {
    const answer = await deps.answerPendingBinding?.({
      onboardingId: route.onboardingId, channel: msg.channel, channelUserId: msg.channelUserId, text: msg.text,
    });
    if (answer?.handled) {
      await deps.send(target(msg), answer.reply);
      return { agent: 'none', sessionId: 'binding' };
    }
  }

  // Unknown identity or still onboarding: one onboarding session per onboardingId, so Telegram <-> web chat continues the same thread.
  const onboardingId = route?.onboardingId ?? (await deps.startOnboarding(msg));
  const sessionId = `onb-${onboardingId}`;
  return converse(msg, deps, opts, 'onboarding', sessionId, { text: msg.text, channel: msg.channel, displayName: msg.displayName, onboardingId });
}
