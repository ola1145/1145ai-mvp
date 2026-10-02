import { mintTenantToken } from '@1145/shared';
import type { InboundMessage } from './lib/types.js';

export interface IdentityRoute {
  role: 'owner' | 'staff' | 'onboarding';
  tid?: string;              // set once the identity is bound to an ACTIVE tenant
  onboardingId?: string;     // set while onboarding
  tenantState?: 'provisioning' | 'active' | 'suspended';
}

export interface RouterDeps {
  lookupIdentity(channel: string, channelUserId: string): Promise<IdentityRoute | undefined>;
  startOnboarding(msg: InboundMessage): Promise<string>;              // creates ONBOARDING record + IDENTITY route; returns onboardingId
  invokeAgent(agent: 'onboarding' | 'admin', sessionId: string, payload: AgentPayload): Promise<string>;
  /** POST /v1/admin/changes/apply with an OWNER token. Deterministic: the LLM is not in this path. */
  applyChange(code: string, ownerToken: string): Promise<{ ok: boolean; message: string }>;
  send(channel: InboundMessage['channel'], chatId: string, text: string): Promise<void>;
  signingSecret(): Promise<string>;
}

/** What the AgentCore runtime receives. Tenant/onboarding ids come from the route, never from message text. */
export interface AgentPayload {
  text: string;
  channel: InboundMessage['channel'];
  displayName?: string;
  onboardingId?: string;
  tenantToken?: string;      // admin agent: used by its tools, never placed in the prompt
}

const CONFIRM_RE = /^\s*confirm\s+(\d{4})\s*$/i;

export async function routeInbound(msg: InboundMessage, deps: RouterDeps): Promise<{ agent: 'onboarding' | 'admin'; sessionId: string }> {
  const route = await deps.lookupIdentity(msg.channel, msg.channelUserId);

  if (route?.tid && route.tenantState === 'active' && (route.role === 'owner' || route.role === 'staff')) {
    // "Confirm before any change": the admin agent can only PROPOSE. The owner's own reply, from the channel
    // identity bound at signup, applies it. Only owners can confirm; staff get the agent.
    const confirm = CONFIRM_RE.exec(msg.text);
    if (confirm?.[1] && route.role === 'owner') {
      const ownerToken = mintTenantToken({ tid: route.tid, prn: 'owner', ch: msg.channel, cid: msg.channelMessageId }, await deps.signingSecret(), 120);
      const r = await deps.applyChange(confirm[1], ownerToken);
      await deps.send(msg.channel, msg.chatId, r.message);
      return { agent: 'admin', sessionId: 'confirm' };
    }
    const token = mintTenantToken({ tid: route.tid, prn: 'admin-agent', ch: msg.channel, cid: msg.channelMessageId }, await deps.signingSecret(), 900);
    const sessionId = `admin-${route.tid}-${msg.channel}-${msg.channelUserId}`;
    const reply = await deps.invokeAgent('admin', sessionId, { text: msg.text, channel: msg.channel, displayName: msg.displayName, tenantToken: token });
    await deps.send(msg.channel, msg.chatId, reply);
    return { agent: 'admin', sessionId };
  }

  if (route?.tenantState === 'suspended') {
    await deps.send(msg.channel, msg.chatId, 'Your 1145 account is paused. Open your dashboard to update billing, or reply HELP to reach a person.');
    return { agent: 'admin', sessionId: 'suspended' };
  }

  // Unknown identity or still onboarding: one onboarding session per onboardingId, so WhatsApp -> web chat continues the same thread.
  const onboardingId = route?.onboardingId ?? (await deps.startOnboarding(msg));
  const sessionId = `onb-${onboardingId}`;
  const reply = await deps.invokeAgent('onboarding', sessionId, { text: msg.text, channel: msg.channel, displayName: msg.displayName, onboardingId });
  await deps.send(msg.channel, msg.chatId, reply);
  return { agent: 'onboarding', sessionId };
}
