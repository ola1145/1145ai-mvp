import { maskPhone, type TenantRuntimeState, type TenantId } from '@1145/shared';
import { dialOut } from './dial-out.js';
import { LiveKitTelnyxEngine, type LiveKitAdapterDeps } from './engine.js';
import { RouteStateError } from './errors.js';
import type { LiveKitAdapterConfig, LiveKitAdapterPorts } from './ports.js';
import { workerEventVerifier } from './worker-events.js';

const DEFAULT_AGENT_NAME = 'frontdesk';
const DEFAULT_RINGING_SEC = 30;
const DEFAULT_MAX_CALL_SEC = 120;

function required(value: string | undefined, name: string): string {
  const v = value?.trim();
  if (!v) throw new Error(`LiveKit adapter: ${name} is required`);
  return v;
}

/**
 * Concrete `LiveKitAdapterDeps` over small ports. Wire it with the real `createLiveKitClients(...)`,
 * the provisioning lane's Telnyx client and DynamoDB-backed stores in a Lambda; wire it with fakes in tests.
 */
export function createLiveKitAdapterDeps(config: LiveKitAdapterConfig, ports: LiveKitAdapterPorts): LiveKitAdapterDeps {
  const telnyxConnectionId = required(config.telnyxConnectionId, 'telnyxConnectionId');
  const outboundTrunkId = required(config.outboundTrunkId, 'outboundTrunkId');
  const agentName = config.agentName === undefined ? DEFAULT_AGENT_NAME : required(config.agentName, 'agentName');
  const now = config.now ?? (() => new Date());
  const verifyWorkerEvent = workerEventVerifier({ tokenSecrets: config.tokenSecrets, now, webhooks: ports.webhooks });

  async function setRouteState(tenantId: TenantId, state: TenantRuntimeState): Promise<void> {
    const numbers = await ports.routes.numbersFor(tenantId);
    const failed: string[] = [];
    // Try every number even if one fails: a half-applied kill switch is worse than a loud error.
    for (const number of numbers) {
      try {
        await ports.routes.setNumberState(number, tenantId, state);   // false = moved to another tenant: not ours to change
      } catch {
        failed.push(maskPhone(number));
      }
    }
    if (failed.length) throw new RouteStateError(failed, numbers.length);
  }

  return {
    saveRuntimeConfig: (tenantId, cfg) => ports.config.saveRuntimeConfig(tenantId, cfg),
    // Defence in depth: only owner-verified docs ever reach the customer agent's index.
    saveVerifiedKnowledge: (tenantId, docs) => ports.knowledge.replaceVerified(tenantId, docs.filter((d) => d.verified)),
    putNumberRoute: (number, tenantId, state) => ports.routes.putNumberRoute(number, { tid: tenantId, engine: 'livekit-telnyx', state }),
    deleteNumberRoute: (number) => ports.routes.deleteNumberRoute(number),
    setRouteState,
    putEngineAgentRoute: (agentId, tenantId) => ports.routes.putEngineAgentRoute('livekit-telnyx', agentId, { tid: tenantId }),
    telnyxAssignToConnection: (number) => ports.telnyx.assignToConnection(number, telnyxConnectionId),
    dialOut: (params) => dialOut({
      sip: ports.sip, dispatch: ports.dispatch, routes: ports.routes, agentName, outboundTrunkId,
      ringingTimeoutSec: config.smokeCall?.ringingTimeoutSec ?? DEFAULT_RINGING_SEC,
      maxCallSec: config.smokeCall?.maxCallSec ?? DEFAULT_MAX_CALL_SEC,
    }, params),
    verifyWorkerEvent,
  };
}

/** `VoiceEngine` for the default (B+) engine. */
export function createLiveKitEngine(config: LiveKitAdapterConfig, ports: LiveKitAdapterPorts): LiveKitTelnyxEngine {
  return new LiveKitTelnyxEngine(createLiveKitAdapterDeps(config, ports), { now: config.now, newId: config.newId });
}
