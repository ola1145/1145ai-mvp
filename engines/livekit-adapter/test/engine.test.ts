import { describe, expect, it } from 'vitest';
import type { EngineAgentRef, NumberBinding, VoiceEngine } from '@1145/shared';
import {
  createLiveKitAdapterDeps, createLiveKitEngine, LiveKitTelnyxEngine, RouteStateError, type LiveKitAdapterConfig,
} from '../src/index.js';
import {
  CONNECTION_ID, NUMBER, NUMBER_2, OTHER, OWNER_PHONE, SECRET, TENANT, TRUNK_ID, agentCfg,
  fakeDispatch, fakePorts, fakeRoutes, fakeSip, fakeStores, fakeTelnyx, type Log,
} from './fakes.js';

const config: LiveKitAdapterConfig = {
  telnyxConnectionId: CONNECTION_ID, outboundTrunkId: TRUNK_ID, tokenSecrets: async () => [SECRET],
  now: () => new Date(1_800_000_000_000), newId: () => 'ab12cd34',
};
const REF: EngineAgentRef = { engine: 'livekit-telnyx', tenantId: TENANT, agentId: `frontdesk:${TENANT}` };
const BINDING: NumberBinding = { engine: 'livekit-telnyx', number: NUMBER };

function engine(opts: Parameters<typeof fakePorts>[0] = {}) {
  const t = fakePorts(opts);
  return { ...t, engine: createLiveKitEngine(config, t.ports) };
}

describe('LiveKitTelnyxEngine implements VoiceEngine', () => {
  it('is the livekit-telnyx engine and satisfies the shared interface', () => {
    const e: VoiceEngine = engine().engine;
    expect(e.id).toBe('livekit-telnyx');
    expect(e).toBeInstanceOf(LiveKitTelnyxEngine);
  });

  describe('provisionTenantAgent', () => {
    it('saves the runtime config, records the engine route, and returns the frontdesk ref', async () => {
      const t = engine({ seed: {} });
      const ref = await t.engine.provisionTenantAgent(TENANT, agentCfg);
      expect(ref).toEqual(REF);
      expect(t.stores.saved).toEqual([{ tenantId: TENANT, cfg: agentCfg }]);
      expect(t.routes.agentRoutes.get(`livekit-telnyx#frontdesk:${TENANT}`)).toBe(TENANT);
    });

    it('rejects a tenant id that is not a tenant id, writing nothing', async () => {
      const t = engine();
      await expect(t.engine.provisionTenantAgent('t_x' as never, agentCfg)).rejects.toThrow(/tenant id/);
      expect(t.log).toEqual([]);
    });
  });

  describe('updateTenantAgent and syncKnowledge', () => {
    it('updateTenantAgent writes the config for the ref tenant', async () => {
      const t = engine();
      await t.engine.updateTenantAgent(REF, { ...agentCfg, agentName: 'Mia' });
      expect(t.stores.saved).toEqual([{ tenantId: TENANT, cfg: { ...agentCfg, agentName: 'Mia' } }]);
    });

    it('refuses a ref from another engine or one whose agent id belongs to someone else', async () => {
      const t = engine();
      await expect(t.engine.updateTenantAgent({ ...REF, engine: 'elevenlabs' }, agentCfg)).rejects.toThrow(/EngineRefMismatch/);
      await expect(t.engine.updateTenantAgent({ ...REF, agentId: `frontdesk:${OTHER}` }, agentCfg)).rejects.toThrow(/EngineRefMismatch/);
      await expect(t.engine.syncKnowledge({ ...REF, engine: 'elevenlabs' }, [])).rejects.toThrow(/EngineRefMismatch/);
      expect(t.log).toEqual([]);
    });

    it('syncKnowledge passes verified docs only', async () => {
      const t = engine();
      await t.engine.syncKnowledge(REF, [
        { id: 'hours', text: 'Mon-Fri 8-5', source: 'owner', verified: true },
        { id: 'scraped', text: 'unverified claim', source: 'website', verified: false },
        { id: 'services', text: 'Cleanings, whitening', source: 'owner', verified: true },
      ]);
      expect(t.stores.knowledge).toHaveLength(1);
      expect(t.stores.knowledge[0]!.tenantId).toBe(TENANT);
      expect(t.stores.knowledge[0]!.docs.map((d) => d.id)).toEqual(['hours', 'services']);
      expect(JSON.stringify(t.stores.knowledge)).not.toContain('unverified claim');
    });

    it('syncKnowledge with no verified docs still replaces the index, so removed facts stop being said', async () => {
      const t = engine();
      await t.engine.syncKnowledge(REF, [{ id: 'x', text: 'unverified', source: 'website', verified: false }]);
      expect(t.stores.knowledge).toEqual([{ tenantId: TENANT, docs: [] }]);
    });
  });

  describe('bindNumber and unbindNumber', () => {
    it('points the number at the LiveKit connection first, then writes an active route for the tenant', async () => {
      const t = engine({ seed: {} });
      const binding = await t.engine.bindNumber(REF, NUMBER);
      expect(binding).toEqual(BINDING);
      expect(t.log).toEqual(['telnyx.assignToConnection', 'routes.putNumberRoute']);
      expect(t.telnyx.assigned).toEqual([{ number: NUMBER, connectionId: CONNECTION_ID }]);
      expect(t.routes.numbers.get(NUMBER)).toEqual({ tid: TENANT, state: 'active', engine: 'livekit-telnyx' });
    });

    it('writes no route when the carrier refuses the assignment', async () => {
      const log: Log = [];
      const routes = fakeRoutes(log, {});
      const stores = fakeStores(log);
      const e = createLiveKitEngine(config, {
        sip: fakeSip(log).port, dispatch: fakeDispatch(log).port, telnyx: fakeTelnyx(log, new Error('telnyx 422')).port,
        routes: routes.port, config: stores.config, knowledge: stores.kb,
      });
      await expect(e.bindNumber(REF, NUMBER)).rejects.toThrow('telnyx 422');
      expect(log).toEqual(['telnyx.assignToConnection']);
      expect(routes.numbers.size).toBe(0);
    });

    it('never takes a route over from another tenant', async () => {
      const t = engine({ seed: { [NUMBER]: { tid: OTHER, state: 'active', engine: 'livekit-telnyx' } } });
      await expect(t.engine.bindNumber(REF, NUMBER)).rejects.toThrow(/RouteConflict/);
      expect(t.routes.numbers.get(NUMBER)!.tid).toBe(OTHER);
    });

    it('rejects a number that is not E.164 before calling the carrier', async () => {
      const t = engine();
      await expect(t.engine.bindNumber(REF, '5125550100')).rejects.toThrow(/E\.164/);
      expect(t.log).toEqual([]);
    });

    it('unbindNumber deletes the route, and ignores a binding from another engine', async () => {
      const t = engine();
      await t.engine.unbindNumber({ engine: 'elevenlabs', number: NUMBER, engineNumberId: 'phnum_01' });
      expect(t.routes.numbers.has(NUMBER)).toBe(true);
      await t.engine.unbindNumber(BINDING);
      expect(t.routes.numbers.has(NUMBER)).toBe(false);
    });
  });

  describe('setTenantState flips route state', () => {
    it.each(['suspended', 'over_cap', 'active'] as const)('%s is written to every number the tenant owns', async (state) => {
      const t = engine({ seed: {
        [NUMBER]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' },
        [NUMBER_2]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' },
        '+15125550122': { tid: OTHER, state: 'active', engine: 'livekit-telnyx' },
      } });
      await t.engine.setTenantState(REF, state);
      expect(t.routes.stateWrites).toEqual([
        { number: NUMBER, tenantId: TENANT, state }, { number: NUMBER_2, tenantId: TENANT, state },
      ]);
      expect(t.routes.numbers.get('+15125550122')!.state).toBe('active');
    });

    it('suspends and then resumes', async () => {
      const t = engine();
      await t.engine.setTenantState(REF, 'suspended');
      expect(t.routes.numbers.get(NUMBER)!.state).toBe('suspended');
      await t.engine.setTenantState(REF, 'active');
      expect(t.routes.numbers.get(NUMBER)!.state).toBe('active');
    });

    it('does not touch a number that now belongs to someone else', async () => {
      const t = engine({ seed: { [NUMBER]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' } } });
      // The route moved between listing the tenant's numbers and updating it: the conditional write answers false.
      const original = t.ports.routes.numbersFor;
      t.ports.routes.numbersFor = async (tid) => { const n = await original(tid); t.routes.numbers.set(NUMBER, { tid: OTHER, state: 'active', engine: 'livekit-telnyx' }); return n; };
      await expect(t.engine.setTenantState(REF, 'suspended')).resolves.toBeUndefined();
      expect(t.routes.numbers.get(NUMBER)).toEqual({ tid: OTHER, state: 'active', engine: 'livekit-telnyx' });
    });

    it('is a no-op for a tenant with no numbers yet', async () => {
      const t = engine({ seed: {} });
      await expect(t.engine.setTenantState(REF, 'suspended')).resolves.toBeUndefined();
      expect(t.log).toEqual([]);
    });

    it('tries every number even if one write fails, then fails loudly so the caller does not record a suspension that did not happen', async () => {
      const t = engine({ seed: {
        [NUMBER]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' },
        [NUMBER_2]: { tid: TENANT, state: 'active', engine: 'livekit-telnyx' },
      } });
      t.routes.failOn.add(NUMBER);
      const err = await t.engine.setTenantState(REF, 'suspended').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RouteStateError);
      expect((err as RouteStateError).failed).toHaveLength(1);
      expect((err as Error).message).not.toContain(NUMBER);   // numbers are masked in errors and logs
      expect(t.routes.numbers.get(NUMBER_2)!.state).toBe('suspended');
    });

    it('refuses a ref from another engine', async () => {
      const t = engine();
      await expect(t.engine.setTenantState({ ...REF, engine: 'elevenlabs' }, 'suspended')).rejects.toThrow(/EngineRefMismatch/);
      expect(t.log).toEqual([]);
    });
  });

  describe('placeSmokeTestCall', () => {
    it('dials the owner from the tenant number in a smoke room, and returns the call id events will carry', async () => {
      const t = engine();
      const { callId } = await t.engine.placeSmokeTestCall(REF, NUMBER, OWNER_PHONE);
      expect(callId).toBe('SCL_call_01');
      expect(t.dispatch.created[0]!.room).toBe(`smoke-${TENANT}-1800000000000-ab12cd34`);
      expect(t.sip.calls[0]).toMatchObject({ to: OWNER_PHONE, room: `smoke-${TENANT}-1800000000000-ab12cd34` });
      expect(t.sip.calls[0]!.opts).toMatchObject({ fromNumber: NUMBER });
    });

    it('uses a fresh room for every call, even within the same millisecond', async () => {
      const t = fakePorts();
      const e = createLiveKitEngine({ ...config, newId: undefined }, t.ports);   // fixed clock, default random suffix
      await e.placeSmokeTestCall(REF, NUMBER, OWNER_PHONE);
      await e.placeSmokeTestCall(REF, NUMBER, OWNER_PHONE);
      const rooms = t.dispatch.created.map((c) => c.room);
      expect(new Set(rooms).size).toBe(2);
      for (const r of rooms) expect(r).toMatch(/^smoke-t_brightsmiles01-1800000000000-[0-9a-f]{8}$/);
    });

    it('cannot be pointed at another tenant\'s number', async () => {
      const t = engine({ seed: { [NUMBER]: { tid: OTHER, state: 'active', engine: 'livekit-telnyx' } } });
      await expect(t.engine.placeSmokeTestCall(REF, NUMBER, OWNER_PHONE)).rejects.toMatchObject({ reason: 'number_not_routed' });
      expect(t.log).toEqual([]);
    });
  });

  it('normalizeCallEvent is the worker-event verifier', async () => {
    const t = engine();
    await expect(t.engine.normalizeCallEvent('{}', {})).rejects.toThrow(/service token/);
  });
});

describe('createLiveKitAdapterDeps validates its configuration', () => {
  const ports = () => fakePorts().ports;
  it.each([
    ['telnyxConnectionId', { telnyxConnectionId: '' }],
    ['outboundTrunkId', { outboundTrunkId: '' }],
    ['agentName', { agentName: ' ' }],
  ])('requires %s', (_name, bad) => {
    expect(() => createLiveKitAdapterDeps({ ...config, ...bad }, ports())).toThrow();
  });
});
