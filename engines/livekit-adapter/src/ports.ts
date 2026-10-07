import type {
  E164, EngineId, KnowledgeDoc, TenantAgentConfig, TenantId, TenantRuntimeState,
} from '@1145/shared';

/**
 * Small interfaces for everything the adapter talks to. The real livekit-server-sdk classes (`SipClient`,
 * `AgentDispatchClient`, `WebhookReceiver`) satisfy the LiveKit ones structurally (test/livekit-sdk.test.ts compiles
 * that), the provisioning lane's Telnyx client satisfies `TelnyxNumbers`, and its `ddbRouteStore` already has the
 * shape of `putNumberRoute` / `putEngineAgentRoute` below. Tests use in-memory fakes, so nothing here touches a network.
 */

/** The slice of `SipClient` that `dialOut` uses. */
export interface SipDialer {
  createSipParticipant(
    sipTrunkId: string, number: string, roomName: string, opts?: SipDialOptions,
  ): Promise<{ sipCallId: string }>;
}

export interface SipDialOptions {
  /** The tenant's own number: LiveKit puts it in `sip.trunkPhoneNumber`, which is how the worker finds the tenant. */
  fromNumber?: string;
  /** Return only once the callee answers (or throw with the SIP status), so a smoke call reports no-answer clearly. */
  waitUntilAnswered?: boolean;
  /** Seconds the phone may ring. */
  ringingTimeout?: number;
  /** Hard cap on the whole call, in seconds. */
  maxCallDuration?: number;
}

/** The slice of `AgentDispatchClient` that `dialOut` uses. */
export interface AgentDispatcher {
  createDispatch(roomName: string, agentName: string, options?: { metadata?: string }): Promise<{ id: string }>;
  deleteDispatch(dispatchId: string, roomName: string): Promise<void>;
}

/** The slice of `WebhookReceiver` we use: throws unless the body matches LiveKit's signed Authorization JWT. */
export interface WebhookVerifier {
  receive(body: string, authHeader?: string): Promise<{ event: string }>;
}

/** Telnyx number management (services/provisioning `TelnyxClient.assignToConnection`). Holds the API key, not us. */
export interface TelnyxNumbers {
  /** Point an owned number at the FQDN connection that fronts LiveKit SIP. Safe to repeat. */
  assignToConnection(e164: string, connectionId: string): Promise<void>;
}

export interface NumberRoute { tid: string; state: TenantRuntimeState; engine?: string }

/**
 * NUMBER# and ENGINEAGENT# route items (contracts/dynamodb/keys.md) plus the tenant's number list.
 * Implementations must be conditional: a route is created, or rewritten only when it already belongs to the same
 * tenant. A route is never taken over from another tenant.
 */
export interface RouteStore {
  getNumberRoute(number: E164): Promise<NumberRoute | undefined>;
  /** Writes NUMBER#<e164> and makes `numbersFor(tid)` list the number. Throws if another tenant owns the route. */
  putNumberRoute(number: E164, route: { tid: string; engine: EngineId; state: TenantRuntimeState }): Promise<void>;
  deleteNumberRoute(number: E164): Promise<void>;
  /** Numbers the tenant owns (PROFILE.numbers, CR H2-2). */
  numbersFor(tenantId: TenantId): Promise<E164[]>;
  /** Conditional on `tid`. Resolves false, and writes nothing, when the route is gone or now belongs to someone else. */
  setNumberState(number: E164, tenantId: TenantId, state: TenantRuntimeState): Promise<boolean>;
  putEngineAgentRoute(engine: EngineId, agentId: string, route: { tid: string }): Promise<void>;
}

/** Where the resolver reads the tenant's agent from (PROFILE.rendered*): the frontdesk worker loads it per call. */
export interface RuntimeConfigStore {
  saveRuntimeConfig(tenantId: TenantId, cfg: TenantAgentConfig): Promise<void>;
}

/** The per-tenant knowledge index (S3 Vectors). Receives owner-verified docs only and replaces what was there. */
export interface KnowledgeStore {
  replaceVerified(tenantId: TenantId, docs: KnowledgeDoc[]): Promise<void>;
}

export interface LiveKitAdapterPorts {
  sip: SipDialer;
  dispatch: AgentDispatcher;
  telnyx: TelnyxNumbers;
  routes: RouteStore;
  config: RuntimeConfigStore;
  knowledge: KnowledgeStore;
  /** LiveKit's own signed webhooks. Optional: without it they are rejected. */
  webhooks?: WebhookVerifier;
}

export interface LiveKitAdapterConfig {
  /** The name the worker registers under (`WorkerOptions(agent_name=...)`). Defaults to `frontdesk`. */
  agentName?: string;
  /** Telnyx FQDN connection that fronts LiveKit SIP (`TELNYX_CONNECTION_ID`). */
  telnyxConnectionId: string;
  /** LiveKit outbound SIP trunk used for smoke calls (`ST_...`). */
  outboundTrunkId: string;
  /** Current and previous signing secrets for 1145 service tokens, so rotation does not drop events. */
  tokenSecrets(): Promise<readonly string[]>;
  smokeCall?: { ringingTimeoutSec?: number; maxCallSec?: number };
  /** Injected for tests. */
  now?: () => Date;
  newId?: () => string;
}
