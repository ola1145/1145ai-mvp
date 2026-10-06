import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { asTenantId, type NumberBinding, type TenantAgentConfig, type TenantId } from '@1145/shared';
import { ElevenAgentsEngine, UnsupportedEventError, type ElevenAgentsConfig, type RouteStore } from '../src/index.js';

const rec = JSON.parse(readFileSync(new URL('./fixtures/api-responses.json', import.meta.url), 'utf8'));
const TENANT = asTenantId('t_brightsmiles01');
const REF = { engine: 'elevenlabs' as const, tenantId: TENANT, agentId: 'agent_dup_01' };
const NOW = 1_800_000_000;

const cfg: ElevenAgentsConfig = {
  apiKey: 'xi_test_key', webhookSecret: 'wsec', templateAgentId: 'agent_template', suspendedAgentId: 'agent_suspended',
  sipTrunk: { address: 'sip.telnyx.com', username: 'trunk-user', password: 'trunk-pass' },
};
const agentCfg: TenantAgentConfig = {
  agentName: 'Ava', businessName: 'Bright Smiles', timezone: 'America/Chicago', language: 'en-US', voiceId: 'voice_01',
  disclosureLine: "Hi, this is Ava, the AI assistant for Bright Smiles. This call may be recorded.",
  instructions: '# Personality\nWarm and brief.', templateVersion: '0.1.0',
};

interface Sent { method: string; url: string; headers: Record<string, string>; body?: unknown }

/** Fake fetch: answers each request with the next recorded response and records what was sent. */
function fakeHttp(responses: Array<{ status?: number; body?: unknown }>) {
  const sent: Sent[] = [];
  const queue = [...responses];
  const http = (async (url: string, init: RequestInit) => {
    sent.push({ method: String(init.method), url, headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    const status = next.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(next.body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { http, sent, remaining: () => queue.length };
}

function fakeRoutes(binding?: NumberBinding) {
  const agents = new Map<string, TenantId>([['agent_dup_01', TENANT]]);
  const routes: RouteStore = {
    putEngineAgentRoute: async (agentId, tenantId) => { agents.set(agentId, tenantId); },
    tenantForAgent: async (agentId) => agents.get(agentId),
    getBinding: async () => binding,
  };
  return { routes, agents };
}

const BOUND: NumberBinding = { engine: 'elevenlabs', number: '+15125550100', engineNumberId: 'phnum_01' };
const path = (s: Sent) => s.url.replace('https://api.elevenlabs.io', '');

describe('ElevenAgentsEngine against recorded API responses', () => {
  it('provisionTenantAgent duplicates the template, applies tenant config and records the route', async () => {
    const f = fakeHttp([{ body: rec.duplicateAgent }, { body: rec.updateAgent }]);
    const { routes, agents } = fakeRoutes();
    agents.clear();
    const ref = await new ElevenAgentsEngine(cfg, routes, f.http).provisionTenantAgent(TENANT, agentCfg);

    expect(ref).toEqual({ engine: 'elevenlabs', tenantId: TENANT, agentId: 'agent_dup_01' });
    expect(f.sent.map((s) => `${s.method} ${path(s)}`)).toEqual([
      'POST /v1/convai/agents/agent_template/duplicate',
      'PATCH /v1/convai/agents/agent_dup_01',
    ]);
    expect(f.sent[0]!.headers['xi-api-key']).toBe('xi_test_key');
    expect(f.sent[1]!.body).toEqual({
      name: 'Bright Smiles · Ava',
      conversation_config: {
        agent: { first_message: agentCfg.disclosureLine, language: 'en', prompt: { prompt: agentCfg.instructions } },
        tts: { voice_id: 'voice_01' },
      },
      tags: ['template:0.1.0'],
    });
    expect(agents.get('agent_dup_01')).toBe(TENANT);
  });

  it('updateTenantAgent patches the tenant agent and leaves the voice alone when none is set', async () => {
    const f = fakeHttp([{ body: rec.updateAgent }]);
    await new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).updateTenantAgent(REF, { ...agentCfg, voiceId: undefined });
    expect(`${f.sent[0]!.method} ${path(f.sent[0]!)}`).toBe('PATCH /v1/convai/agents/agent_dup_01');
    expect((f.sent[0]!.body as { conversation_config: object }).conversation_config).not.toHaveProperty('tts');
  });

  it('syncKnowledge uploads verified docs only, swaps the agent KB, then deletes superseded docs', async () => {
    const f = fakeHttp([
      { body: rec.getAgentWithKnowledge },
      { body: rec.createKbText[0] }, { body: rec.createKbText[1] },
      { body: rec.updateAgent },
      { status: 204 }, { status: 204 },
    ]);
    await new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).syncKnowledge(REF, [
      { id: 'hours', text: 'Mon-Fri 8-5', source: 'owner', verified: true },
      { id: 'scraped', text: 'unverified claim', source: 'website', verified: false },
      { id: 'services', text: 'Cleanings, whitening', source: 'owner', verified: true },
    ]);

    expect(f.sent.map((s) => `${s.method} ${path(s)}`)).toEqual([
      'GET /v1/convai/agents/agent_dup_01',
      'POST /v1/convai/knowledge-base/text',
      'POST /v1/convai/knowledge-base/text',
      'PATCH /v1/convai/agents/agent_dup_01',
      'DELETE /v1/convai/knowledge-base/kb_old_hours',
      'DELETE /v1/convai/knowledge-base/kb_old_faq',
    ]);
    expect(f.sent[1]!.body).toEqual({ text: 'Mon-Fri 8-5', name: 'hours' });
    expect(JSON.stringify(f.sent.map((s) => s.body))).not.toContain('unverified claim');
    expect(f.sent[3]!.body).toEqual({ conversation_config: { agent: { prompt: { knowledge_base: [
      { type: 'text', id: 'kb_new_hours', name: 'hours' },
      { type: 'text', id: 'kb_new_services', name: 'services' },
    ] } } } });
  });

  it('syncKnowledge tolerates a superseded doc that is already gone', async () => {
    const f = fakeHttp([
      { body: rec.getAgentWithKnowledge }, { body: rec.updateAgent }, { status: 404 }, { status: 204 },
    ]);
    await expect(new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).syncKnowledge(REF, [])).resolves.toBeUndefined();
    expect(f.remaining()).toBe(0);
  });

  it('bindNumber imports the number over the SIP trunk already assigned to the agent', async () => {
    const f = fakeHttp([{ body: rec.createPhoneNumber }]);
    const binding = await new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).bindNumber(REF, '+15125550100');

    expect(binding).toEqual(BOUND);
    expect(`${f.sent[0]!.method} ${path(f.sent[0]!)}`).toBe('POST /v1/convai/phone-numbers');
    expect(f.sent[0]!.body).toEqual({
      provider: 'sip_trunk', phone_number: '+15125550100', label: TENANT, agent_id: 'agent_dup_01',
      inbound_trunk_config: {},
      outbound_trunk_config: { address: 'sip.telnyx.com', credentials: { username: 'trunk-user', password: 'trunk-pass' } },
    });
  });

  it('bindNumber omits credentials for an ACL-authenticated trunk', async () => {
    const f = fakeHttp([{ body: rec.createPhoneNumber }]);
    await new ElevenAgentsEngine({ ...cfg, sipTrunk: { address: 'sip.telnyx.com' } }, fakeRoutes().routes, f.http).bindNumber(REF, '+15125550100');
    expect((f.sent[0]!.body as { outbound_trunk_config: object }).outbound_trunk_config).toEqual({ address: 'sip.telnyx.com' });
  });

  it('unbindNumber deletes the imported number, and is a no-op without one', async () => {
    const f = fakeHttp([{ status: 204 }]);
    const engine = new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http);
    await engine.unbindNumber(BOUND);
    await engine.unbindNumber({ engine: 'elevenlabs', number: '+15125550100' });
    expect(f.sent.map((s) => `${s.method} ${path(s)}`)).toEqual(['DELETE /v1/convai/phone-numbers/phnum_01']);
  });

  it.each([
    ['active', 'agent_dup_01'],
    ['suspended', 'agent_suspended'],
    ['over_cap', 'agent_suspended'],
  ] as const)('setTenantState(%s) points the number at %s', async (state, agentId) => {
    const f = fakeHttp([{ body: rec.updatePhoneNumber }]);
    await new ElevenAgentsEngine(cfg, fakeRoutes(BOUND).routes, f.http).setTenantState(REF, state);
    expect(`${f.sent[0]!.method} ${path(f.sent[0]!)}`).toBe('PATCH /v1/convai/phone-numbers/phnum_01');
    expect(f.sent[0]!.body).toEqual({ agent_id: agentId });
  });

  it('setTenantState does nothing when no number is bound', async () => {
    const f = fakeHttp([]);
    await new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).setTenantState(REF, 'suspended');
    expect(f.sent).toHaveLength(0);
  });

  it('placeSmokeTestCall dials out over the SIP trunk and returns the conversation id', async () => {
    const f = fakeHttp([{ body: rec.sipOutboundCall }]);
    const r = await new ElevenAgentsEngine(cfg, fakeRoutes(BOUND).routes, f.http).placeSmokeTestCall(REF, '+15125550100', '+15125550199');
    expect(r).toEqual({ callId: 'conv_smoke_01' });
    expect(`${f.sent[0]!.method} ${path(f.sent[0]!)}`).toBe('POST /v1/convai/sip-trunk/outbound-call');
    expect(f.sent[0]!.body).toEqual({ agent_id: 'agent_dup_01', agent_phone_number_id: 'phnum_01', to_number: '+15125550199' });
  });

  it('placeSmokeTestCall throws when the API reports the call failed, or no number is bound', async () => {
    const failed = fakeHttp([{ body: rec.sipOutboundCallFailed }]);
    await expect(new ElevenAgentsEngine(cfg, fakeRoutes(BOUND).routes, failed.http)
      .placeSmokeTestCall(REF, '+15125550100', '+15125550199')).rejects.toThrow('Number not reachable');
    await expect(new ElevenAgentsEngine(cfg, fakeRoutes().routes, fakeHttp([]).http)
      .placeSmokeTestCall(REF, '+15125550100', '+15125550199')).rejects.toThrow('number not bound');
  });

  it('HTTP errors carry method, path and status but never the API key', async () => {
    const f = fakeHttp([{ status: 422, body: { detail: 'bad config' } }]);
    const err = await new ElevenAgentsEngine(cfg, fakeRoutes().routes, f.http).updateTenantAgent(REF, agentCfg).catch((e: Error) => e);
    expect(String(err)).toContain('PATCH /v1/convai/agents/agent_dup_01 -> 422');
    expect(String(err)).not.toContain('xi_test_key');
  });
});

describe('normalizeCallEvent', () => {
  const sign = (body: string, t = NOW) => `t=${t},v0=${createHmac('sha256', 'wsec').update(`${t}.${body}`).digest('hex')}`;
  const engine = () => new ElevenAgentsEngine(cfg, fakeRoutes().routes, fakeHttp([]).http, () => NOW);
  const body = JSON.stringify(rec.postCallTranscription);

  it('maps a recorded post_call_transcription payload to call.ended', async () => {
    const ev = await engine().normalizeCallEvent(body, { 'elevenlabs-signature': sign(body) });
    expect(ev).toEqual({
      type: 'call.ended', engine: 'elevenlabs', tenantId: TENANT, callId: 'conv_01',
      occurredAt: new Date(NOW * 1000).toISOString(), durationSec: 58,
      transcript: [
        { role: 'agent', text: 'Hi, this is Ava at Bright Smiles. How can I help?', atSec: 0 },
        { role: 'caller', text: 'Can I move my cleaning to Friday?', atSec: 4 },
      ],
      analysis: { summary: 'Caller asked to move a cleaning to Friday.' },
    });
  });

  it('finds the signature header whatever its case', async () => {
    await expect(engine().normalizeCallEvent(body, { 'ElevenLabs-Signature': sign(body) })).resolves.toMatchObject({ callId: 'conv_01' });
  });

  it('throws on a bad, missing or stale signature', async () => {
    await expect(engine().normalizeCallEvent(body, { 'elevenlabs-signature': sign(body + ' ') })).rejects.toThrow('bad signature');
    await expect(engine().normalizeCallEvent(body, {})).rejects.toThrow('bad signature');
    await expect(engine().normalizeCallEvent(body, { 'elevenlabs-signature': sign(body, NOW - 4000) })).rejects.toThrow('bad signature');
  });

  it('throws for an agent that maps to no tenant (tenant never comes from the payload)', async () => {
    const other = JSON.stringify({ ...rec.postCallTranscription, data: { ...rec.postCallTranscription.data, agent_id: 'agent_unknown' } });
    await expect(engine().normalizeCallEvent(other, { 'elevenlabs-signature': sign(other) })).rejects.toThrow('unknown agent');
  });

  it('rejects other webhook types with UnsupportedEventError so the receiver can acknowledge and drop them', async () => {
    const failure = JSON.stringify(rec.callInitiationFailure);
    await expect(engine().normalizeCallEvent(failure, { 'elevenlabs-signature': sign(failure) })).rejects.toBeInstanceOf(UnsupportedEventError);
  });
});
