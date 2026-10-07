import type { E164, TenantId } from '@1145/shared';
import { DialOutError } from './errors.js';
import type { AgentDispatcher, RouteStore, SipDialer } from './ports.js';

export const E164_RE = /^\+[1-9]\d{6,14}$/;
/** LiveKit room names we create. `chat-` rooms belong to the web widget path (the worker resolves those by widget key). */
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface DialOutEnv {
  sip: SipDialer;
  dispatch: AgentDispatcher;
  routes: Pick<RouteStore, 'getNumberRoute'>;
  agentName: string;
  outboundTrunkId: string;
  ringingTimeoutSec: number;
  maxCallSec: number;
}

export interface DialOutParams { roomName: string; to: E164; fromNumber: E164; tenantId: TenantId }

/**
 * Outbound call with our agent on it (used for the onboarding smoke call).
 *
 * 1. Dispatch "frontdesk" into the room, so the worker is waiting when the owner picks up.
 * 2. `SipClient.createSipParticipant` on the outbound trunk, FROM the tenant's own number.
 *
 * The worker decides the tenant the same way it does for inbound calls: from `sip.trunkPhoneNumber`, which LiveKit
 * documents as the number the call originates from on an outbound trunk (not yet confirmed on a real call: E8 spike).
 * So nothing about the tenant goes into the dispatch or the SIP call, and `fromNumber` must already route to
 * `tenantId`, otherwise the call would run as someone else.
 * Returns the SIP call id, which is the id the worker puts on every event of the call (`sip.callID`).
 */
export async function dialOut(env: DialOutEnv, p: DialOutParams): Promise<string> {
  if (!E164_RE.test(p.to)) throw new DialOutError('invalid_input', 'dialOut: to is not E.164');
  if (!E164_RE.test(p.fromNumber)) throw new DialOutError('invalid_input', 'dialOut: fromNumber is not E.164');
  if (!ROOM_RE.test(p.roomName) || p.roomName.startsWith('chat-')) throw new DialOutError('invalid_input', 'dialOut: unusable room name');

  const route = await env.routes.getNumberRoute(p.fromNumber);
  if (!route || route.tid !== p.tenantId) {
    throw new DialOutError('number_not_routed', 'dialOut: fromNumber does not route to this tenant');
  }

  let dispatchId: string;
  try {
    dispatchId = (await env.dispatch.createDispatch(p.roomName, env.agentName)).id;
  } catch (err) {
    throw new DialOutError('dispatch_failed', `dialOut: could not dispatch the agent: ${describe(err)}`);
  }

  try {
    const participant = await env.sip.createSipParticipant(env.outboundTrunkId, p.to, p.roomName, {
      fromNumber: p.fromNumber,
      waitUntilAnswered: true,
      ringingTimeout: env.ringingTimeoutSec,
      maxCallDuration: env.maxCallSec,
    });
    return participant.sipCallId || p.roomName;   // the worker falls back to the room name the same way
  } catch (err) {
    // Nobody picked up (or the carrier refused): don't leave an agent job waiting in an empty room.
    await env.dispatch.deleteDispatch(dispatchId, p.roomName).catch(() => undefined);
    throw new DialOutError('dial_failed', `dialOut: the call was not connected: ${describe(err)}`, sipStatus(err));
  }
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
}

function sipStatus(err: unknown): number | undefined {
  const code = (err as { sipStatusCode?: unknown } | null)?.sipStatusCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}
