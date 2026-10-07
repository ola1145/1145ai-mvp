import {
  asTenantId,
  type E164, type KnowledgeDoc, type TenantAgentConfig, type TenantId, type TenantRuntimeState,
} from '@1145/shared';
import type {
  AgentDispatcher, KnowledgeStore, LiveKitAdapterPorts, NumberRoute, RouteStore, RuntimeConfigStore, SipDialer,
  TelnyxNumbers, WebhookVerifier,
} from '../src/ports.js';

export const TENANT = asTenantId('t_brightsmiles01');
export const OTHER = asTenantId('t_othershop0001');
export const NUMBER: E164 = '+15125550100';
export const NUMBER_2: E164 = '+15125550111';
export const OWNER_PHONE: E164 = '+12145550199';
export const CONNECTION_ID = 'telnyx_conn_01';
export const TRUNK_ID = 'ST_outbound01';
export const SECRET = 'service-token-secret-current';
export const OLD_SECRET = 'service-token-secret-previous';
export const NOW = 1_800_000_000;
export const NOW_MS = NOW * 1000;

export const agentCfg: TenantAgentConfig = {
  agentName: 'Ava', businessName: 'Bright Smiles', timezone: 'America/Chicago', language: 'en-US', voiceId: 'voice_01',
  disclosureLine: 'Hi, this is Ava, the AI assistant for Bright Smiles. This call may be recorded.',
  instructions: '# Personality\nWarm and brief.', templateVersion: '0.1.0',
};

/** One shared, ordered log of every port call so tests can assert ordering across ports. */
export type Log = string[];

export interface SipCall { trunkId: string; to: string; room: string; opts: Record<string, unknown> | undefined }

export function fakeSip(log: Log, behavior: { reply?: { sipCallId: string }; error?: Error } = {}) {
  const calls: SipCall[] = [];
  const port: SipDialer = {
    async createSipParticipant(trunkId, to, room, opts) {
      log.push('sip.createSipParticipant');
      calls.push({ trunkId, to, room, opts: opts as Record<string, unknown> | undefined });
      if (behavior.error) throw behavior.error;
      return behavior.reply ?? { sipCallId: 'SCL_call_01' };
    },
  };
  return { port, calls };
}

export interface DispatchCall { room: string; agentName: string; options: Record<string, unknown> | undefined }

export function fakeDispatch(log: Log, behavior: { createError?: Error; deleteError?: Error } = {}) {
  const created: DispatchCall[] = [];
  const deleted: Array<{ id: string; room: string }> = [];
  const port: AgentDispatcher = {
    async createDispatch(room, agentName, options) {
      log.push('dispatch.createDispatch');
      created.push({ room, agentName, options: options as Record<string, unknown> | undefined });
      if (behavior.createError) throw behavior.createError;
      return { id: 'AD_dispatch_01' };
    },
    async deleteDispatch(id, room) {
      log.push('dispatch.deleteDispatch');
      deleted.push({ id, room });
      if (behavior.deleteError) throw behavior.deleteError;
    },
  };
  return { port, created, deleted };
}

export function fakeTelnyx(log: Log, error?: Error) {
  const assigned: Array<{ number: string; connectionId: string }> = [];
  const port: TelnyxNumbers = {
    async assignToConnection(number, connectionId) {
      log.push('telnyx.assignToConnection');
      if (error) throw error;
      assigned.push({ number, connectionId });
    },
  };
  return { port, assigned };
}

/** In-memory twin of the NUMBER# / ENGINEAGENT# route items plus the tenant's number list. */
export function fakeRoutes(log: Log, seed: Record<E164, NumberRoute> = {}) {
  const numbers = new Map<E164, NumberRoute>(Object.entries(seed));
  const agentRoutes = new Map<string, string>();
  const failOn = new Set<E164>();
  const stateWrites: Array<{ number: E164; tenantId: TenantId; state: TenantRuntimeState }> = [];
  const port: RouteStore = {
    async getNumberRoute(number) { return numbers.get(number); },
    async putNumberRoute(number, route) {
      log.push('routes.putNumberRoute');
      const existing = numbers.get(number);
      if (existing && existing.tid !== route.tid) throw new Error(`RouteConflict: NUMBER already routes to another tenant`);
      numbers.set(number, { tid: route.tid, state: route.state, engine: route.engine });
    },
    async deleteNumberRoute(number) { log.push('routes.deleteNumberRoute'); numbers.delete(number); },
    async numbersFor(tenantId) { return [...numbers].filter(([, r]) => r.tid === tenantId).map(([n]) => n); },
    async setNumberState(number, tenantId, state) {
      log.push('routes.setNumberState');
      if (failOn.has(number)) throw new Error('dynamodb unavailable');
      const r = numbers.get(number);
      if (!r || r.tid !== tenantId) return false;
      numbers.set(number, { ...r, state });
      stateWrites.push({ number, tenantId, state });
      return true;
    },
    async putEngineAgentRoute(engine, agentId, route) {
      log.push('routes.putEngineAgentRoute');
      agentRoutes.set(`${engine}#${agentId}`, route.tid);
    },
  };
  return { port, numbers, agentRoutes, failOn, stateWrites };
}

export function fakeStores(log: Log) {
  const saved: Array<{ tenantId: TenantId; cfg: TenantAgentConfig }> = [];
  const knowledge: Array<{ tenantId: TenantId; docs: KnowledgeDoc[] }> = [];
  const config: RuntimeConfigStore = {
    async saveRuntimeConfig(tenantId, cfg) { log.push('config.saveRuntimeConfig'); saved.push({ tenantId, cfg }); },
  };
  const kb: KnowledgeStore = {
    async replaceVerified(tenantId, docs) { log.push('knowledge.replaceVerified'); knowledge.push({ tenantId, docs }); },
  };
  return { config, kb, saved, knowledge };
}

export function fakeWebhooks(behavior: { event?: string; error?: Error } = {}) {
  const seen: Array<{ body: string; auth: string | undefined }> = [];
  const port: WebhookVerifier = {
    async receive(body, auth) {
      seen.push({ body, auth });
      if (behavior.error) throw behavior.error;
      return { event: behavior.event ?? 'room_finished' };
    },
  };
  return { port, seen };
}

/** Everything wired together over fakes. */
export function fakePorts(opts: { seed?: Record<E164, NumberRoute> } = {}) {
  const log: Log = [];
  const sip = fakeSip(log);
  const dispatch = fakeDispatch(log);
  const telnyx = fakeTelnyx(log);
  const routes = fakeRoutes(log, opts.seed ?? { [NUMBER]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' } });
  const stores = fakeStores(log);
  const ports: LiveKitAdapterPorts = {
    sip: sip.port, dispatch: dispatch.port, telnyx: telnyx.port, routes: routes.port,
    config: stores.config, knowledge: stores.kb,
  };
  return { log, ports, sip, dispatch, telnyx, routes, stores };
}
