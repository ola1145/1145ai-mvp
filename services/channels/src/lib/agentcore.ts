import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { AgentPayload, RouterDeps } from '../router.js';
import { runtimeSessionId } from './session.js';

export interface AgentRuntimeArns { onboarding: string; admin: string }

/** The slice of BedrockAgentCoreClient we use, so tests can pass a fake. */
export interface AgentRuntimeClient {
  send(
    command: InvokeAgentRuntimeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ response?: { transformToString(): Promise<string> } }>;
}

export class AgentInvokeError extends Error {}

/** Hard stop for one agent call. The router sends a holding line at 25 s; this is the point where we give up. */
export const DEFAULT_AGENT_TIMEOUT_MS = 110_000;

/** The runtime returns {"reply": "..."}; tolerate a bare JSON string or plain text too. */
export function parseAgentReply(raw: string): string {
  const text = raw.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return parsed.trim();
    if (parsed && typeof parsed === 'object' && typeof (parsed as { reply?: unknown }).reply === 'string') return (parsed as { reply: string }).reply.trim();
  } catch {
    // not JSON: plain text
  }
  return text;
}

/**
 * InvokeAgentRuntime with runtimeSessionId derived from the router's sessionId (padded to the 33-char minimum), so the
 * same onboarding or owner keeps one AgentCore Memory thread across web chat and Telegram. The payload is built by the
 * router from verified identity; nothing in it is chosen by the model.
 */
export function createAgentInvoker(cfg: { client: AgentRuntimeClient; arns: AgentRuntimeArns; timeoutMs?: number }): RouterDeps['invokeAgent'] {
  return async (agent: 'onboarding' | 'admin', sessionId: string, payload: AgentPayload): Promise<string> => {
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: cfg.arns[agent],
      runtimeSessionId: runtimeSessionId(sessionId),
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });
    let raw: string;
    try {
      const out = await cfg.client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });
      raw = (await out.response?.transformToString()) ?? '';
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(String((err as Error).message))) {
        throw new AgentInvokeError(`agent ${agent} timed out after ${timeoutMs} ms`);
      }
      throw err;
    }
    const reply = parseAgentReply(raw);
    if (!reply) throw new AgentInvokeError(`agent ${agent} returned an empty reply`);
    return reply;
  };
}
