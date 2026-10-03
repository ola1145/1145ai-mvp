import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeLivekit, type FakeState } from './fake-livekit.js';
import { buildDesired, main, reconcileLivekit, type LivekitSettings } from '../setup.js';
import { LivekitSipClient, httpUrlFromLivekitUrl } from '../api.js';

const fixture = (name: string): FakeState => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as FakeState;

const KEY = 'APIfixturekey';
const SECRET = 'fixture-livekit-secret-not-real';
const SIP_USER = 'fixture-sip-user';
const SIP_PASS = 'fixture-sip-pass-not-real';
const settings: LivekitSettings = { stage: 'dev', sipUsername: SIP_USER, sipPassword: SIP_PASS };

const setup = (fixtureName: string) => {
  const fake = new FakeLivekit(fixture(fixtureName), KEY, SECRET);
  const client = new LivekitSipClient('https://fixture.livekit.cloud', KEY, SECRET, fake.fetch);
  return { fake, client };
};
const mutating = <T extends { change: string }>(a: T[]) => a.filter((x) => x.change !== 'noop');

describe('desired state', () => {
  it('accepts every number on the connection, one room per call, agent frontdesk, outbound to Telnyx with credentials', () => {
    const d = buildDesired(settings);
    expect(d.inbound.name).toBe('1145-dev-telnyx-inbound');
    expect(d.inbound.numbers).toEqual([]);
    expect(d.dispatch.roomPrefix).toBe('call-');
    expect(d.dispatch.agentName).toBe('frontdesk');
    expect(d.outbound).toMatchObject({ name: '1145-dev-telnyx-outbound', address: 'sip.telnyx.com', authUsername: SIP_USER, numbers: ['*'] });
  });
  it('names resources per stage so dev and prod never share a trunk', () => {
    expect(buildDesired({ ...settings, stage: 'prod' }).inbound.name).toBe('1145-prod-telnyx-inbound');
  });
});

describe('reconcileLivekit on an empty project', () => {
  it('creates inbound trunk, outbound trunk, then a dispatch rule bound to the new inbound trunk', async () => {
    const { fake, client } = setup('empty');
    const actions = await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    expect(actions.map((a) => `${a.change} ${a.resource}`)).toEqual(['create inbound-trunk', 'create outbound-trunk', 'create dispatch-rule']);
    expect(fake.mutations.map((c) => c.method)).toEqual(['CreateSIPInboundTrunk', 'CreateSIPOutboundTrunk', 'CreateSIPDispatchRule']);

    const inboundId = fake.state.inbound.items[0]?.sipTrunkId;
    const rule = fake.state.dispatch.items[0] as Record<string, any>;
    expect(rule.trunkIds).toEqual([inboundId]);
    expect(rule.rule).toEqual({ dispatchRuleIndividual: { roomPrefix: 'call-' } });
    expect(rule.roomConfig.agents).toEqual([{ agentName: 'frontdesk' }]);
    const out = fake.state.outbound.items[0] as Record<string, any>;
    expect(out).toMatchObject({ address: 'sip.telnyx.com', authUsername: SIP_USER, authPassword: SIP_PASS, numbers: ['*'] });
  });

  it('is idempotent: the second run makes no changes and no mutating calls', async () => {
    const { fake, client } = setup('empty');
    await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    fake.clearCalls();
    const again = await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    expect(mutating(again)).toEqual([]);
    expect(fake.mutations).toEqual([]);
    expect(fake.state.inbound.items).toHaveLength(1);
    expect(fake.state.outbound.items).toHaveLength(1);
    expect(fake.state.dispatch.items).toHaveLength(1);
  });

  it('--dry-run reports the plan and writes nothing', async () => {
    const { fake, client } = setup('empty');
    const actions = await reconcileLivekit(client, buildDesired(settings), { dryRun: true });
    expect(actions.map((a) => a.change)).toEqual(['create', 'create', 'create']);
    expect(fake.mutations).toEqual([]);
    expect(fake.state.inbound.items).toEqual([]);
  });
});

describe('reconcileLivekit against recorded state', () => {
  it('leaves a converged project alone, including trunks it does not own', async () => {
    const { fake, client } = setup('converged');
    const actions = await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    expect(mutating(actions)).toEqual([]);
    expect(fake.mutations).toEqual([]);
  });

  it('repairs drift (inbound restricted to one number, wrong outbound user, dispatch rule without the agent), then settles', async () => {
    const { fake, client } = setup('drifted');
    const first = await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    expect(first.map((a) => `${a.change} ${a.resource}`)).toEqual(['update inbound-trunk', 'update outbound-trunk', 'update dispatch-rule']);
    expect((fake.state.inbound.items[0] as Record<string, unknown>).sipTrunkId).toBe('ST_fx_in');
    expect((fake.state.dispatch.items[0] as Record<string, any>).roomConfig.agents).toEqual([{ agentName: 'frontdesk' }]);
    fake.clearCalls();
    const second = await reconcileLivekit(client, buildDesired(settings), { dryRun: false });
    expect(mutating(second)).toEqual([]);
    expect(fake.mutations).toEqual([]);
  });

  it('dry-run on drift lists updates without sending them', async () => {
    const { fake, client } = setup('drifted');
    const actions = await reconcileLivekit(client, buildDesired(settings), { dryRun: true });
    expect(actions.map((a) => a.change)).toEqual(['update', 'update', 'update']);
    expect(fake.mutations).toEqual([]);
  });

  it('refuses to guess when two trunks share the managed name', async () => {
    const { client } = setup('duplicate-names');
    await expect(reconcileLivekit(client, buildDesired(settings), { dryRun: false })).rejects.toThrow(/more than one.*1145-dev-telnyx-inbound/i);
  });

  it('--rotate-credentials re-sends the outbound trunk even when it looks converged', async () => {
    const { fake, client } = setup('converged');
    const actions = await reconcileLivekit(client, buildDesired({ ...settings, rotateCredentials: true }), { dryRun: false });
    expect(actions.filter((a) => a.change === 'update').map((a) => a.resource)).toEqual(['outbound-trunk']);
    expect(fake.mutations.map((c) => c.method)).toEqual(['UpdateSIPOutboundTrunk']);
  });
});

describe('client', () => {
  it('turns the websocket URL into the https API URL', () => {
    expect(httpUrlFromLivekitUrl('wss://proj-abc.livekit.cloud')).toBe('https://proj-abc.livekit.cloud');
    expect(httpUrlFromLivekitUrl('ws://localhost:7880/')).toBe('http://localhost:7880');
  });
  it('signs a short-lived admin token the server accepts, and surfaces a rejection', async () => {
    const fake = new FakeLivekit(fixture('empty'), KEY, SECRET);
    const wrong = new LivekitSipClient('https://fixture.livekit.cloud', KEY, 'some-other-secret', fake.fetch);
    await expect(wrong.listInbound()).rejects.toThrow(/401/);
  });
});

describe('main (CLI)', () => {
  const env = { LIVEKIT_URL: 'wss://fixture.livekit.cloud', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, TELNYX_SIP_USERNAME: SIP_USER, TELNYX_SIP_PASSWORD: SIP_PASS };
  const run = async (argv: string[], e: Record<string, string | undefined>, fake: FakeLivekit) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, e, { out: (s) => out.push(s), err: (s) => err.push(s) }, fake.fetch);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('names the missing environment variables and never prints values', async () => {
    const fake = new FakeLivekit(fixture('empty'), KEY, SECRET);
    const r = await run([], { LIVEKIT_URL: 'wss://fixture.livekit.cloud' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toContain('LIVEKIT_API_KEY');
    expect(r.err).toContain('LIVEKIT_API_SECRET');
    expect(r.err).toContain('TELNYX_SIP_PASSWORD');
    expect(fake.calls).toEqual([]);
  });

  it('prints the plan and never the secrets, and writes nothing under --dry-run', async () => {
    const fake = new FakeLivekit(fixture('empty'), KEY, SECRET);
    const r = await run(['--dry-run'], env, fake);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toContain('1145-dev-telnyx-inbound');
    for (const secret of [SECRET, SIP_PASS]) { expect(r.out + r.err).not.toContain(secret); }
    expect(fake.mutations).toEqual([]);
  });

  it('applies on a real run, then reports nothing to change on the second run', async () => {
    const fake = new FakeLivekit(fixture('empty'), KEY, SECRET);
    const first = await run(['--stage', 'dev'], env, fake);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/created/i);
    for (const secret of [SECRET, SIP_PASS]) { expect(first.out + first.err).not.toContain(secret); }
    fake.clearCalls();
    const second = await run(['--stage', 'dev'], env, fake);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/no changes/i);
    expect(fake.mutations).toEqual([]);
  });

  it('rejects unknown flags instead of ignoring them', async () => {
    const fake = new FakeLivekit(fixture('empty'), KEY, SECRET);
    const r = await run(['--dryrun'], env, fake);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--dryrun/);
  });
});
