import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeTelnyx, type TelnyxState } from './fake-telnyx.js';
import { TelnyxClient } from '../api.js';
import { buildDesired, main, reconcileTelnyx, sipHostFromLivekitUrl, type TelnyxSettings } from '../setup.js';

const fixture = (name: string): TelnyxState => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as TelnyxState;

const API_KEY = 'KEYfixture-telnyx-key-not-real';
const SIP_USER = 'fixture-sip-user';
const SIP_PASS = 'fixture-sip-pass-not-real';
const settings: TelnyxSettings = { stage: 'dev', sipHost: 'fixture-proj.sip.livekit.cloud', sipUsername: SIP_USER, sipPassword: SIP_PASS, dailySpendLimit: 25 };

const setup = (name: string) => {
  const fake = new FakeTelnyx(fixture(name), API_KEY);
  return { fake, client: new TelnyxClient(API_KEY, fake.fetch) };
};
const changes = <T extends { change: string }>(a: T[]) => a.filter((x) => x.change !== 'noop');

describe('sipHostFromLivekitUrl', () => {
  it('maps a LiveKit Cloud project URL to its SIP host', () => {
    expect(sipHostFromLivekitUrl('wss://fixture-proj.livekit.cloud')).toBe('fixture-proj.sip.livekit.cloud');
    expect(sipHostFromLivekitUrl('https://fixture-proj.livekit.cloud/')).toBe('fixture-proj.sip.livekit.cloud');
  });
  it('returns null for self-hosted or unknown URLs so the caller must pass --sip-host', () => {
    expect(sipHostFromLivekitUrl('ws://localhost:7880')).toBeNull();
  });
});

describe('desired state', () => {
  it('points an FQDN connection at LiveKit SIP with E.164 numbers, and a credential connection for outbound', () => {
    const d = buildDesired(settings);
    expect(d.fqdnConnection.name).toBe('1145-dev-livekit-inbound');
    expect(d.fqdn).toMatchObject({ fqdn: 'fixture-proj.sip.livekit.cloud', port: 5060 });
    expect(d.credentialConnection).toMatchObject({ name: '1145-dev-livekit-outbound', userName: SIP_USER });
    expect(d.fqdnConnection.inbound).toEqual({ ani_number_format: '+E.164', dnis_number_format: '+e164' });
  });
});

describe('reconcileTelnyx on an empty account', () => {
  it('creates profile, FQDN connection, FQDN, then the credential connection tied to the profile', async () => {
    const { fake, client } = setup('empty');
    const actions = await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(actions.map((a) => `${a.change} ${a.resource}`)).toEqual([
      'create outbound-voice-profile', 'create fqdn-connection', 'create fqdn', 'create credential-connection',
    ]);
    const profile = fake.state.outbound_voice_profiles[0] as Record<string, any>;
    const conn = fake.state.fqdn_connections[0] as Record<string, any>;
    const cred = fake.mutations.find((c) => c.path === '/v2/credential_connections')?.body as Record<string, any>;
    expect(profile).toMatchObject({ name: '1145-dev-outbound', whitelisted_destinations: ['US', 'CA'], daily_spend_limit: '25.00', daily_spend_limit_enabled: true });
    expect(conn).toMatchObject({ connection_name: '1145-dev-livekit-inbound', active: true });
    expect(fake.state.fqdns[0]).toMatchObject({ connection_id: conn.id, fqdn: 'fixture-proj.sip.livekit.cloud', port: 5060, dns_record_type: 'a' });
    expect(cred).toMatchObject({ connection_name: '1145-dev-livekit-outbound', user_name: SIP_USER, password: SIP_PASS, active: true, outbound: { outbound_voice_profile_id: profile.id } });
    expect(actions.find((a) => a.resource === 'fqdn-connection')?.id).toBe(conn.id);
  });

  it('is idempotent: the second run makes no changes and sends no writes', async () => {
    const { fake, client } = setup('empty');
    await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    fake.clearCalls();
    const again = await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(changes(again)).toEqual([]);
    expect(fake.mutations).toEqual([]);
    expect(fake.state.fqdn_connections).toHaveLength(1);
    expect(fake.state.fqdns).toHaveLength(1);
    expect(fake.state.credential_connections).toHaveLength(1);
    expect(fake.state.outbound_voice_profiles).toHaveLength(1);
  });

  it('--dry-run reads only', async () => {
    const { fake, client } = setup('empty');
    const actions = await reconcileTelnyx(client, buildDesired(settings), { dryRun: true });
    expect(actions.map((a) => a.change)).toEqual(['create', 'create', 'create', 'create']);
    expect(fake.mutations).toEqual([]);
    expect(fake.state.fqdn_connections).toEqual([]);
  });

  it('never orders a number or touches call control (setup only manages connections)', async () => {
    const { fake, client } = setup('empty');
    await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(fake.calls.map((c) => c.path).filter((p) => /number_orders|available_phone_numbers|phone_numbers|actions/.test(p))).toEqual([]);
  });
});

describe('reconcileTelnyx against recorded state', () => {
  it('leaves a converged account alone, following list pages to find the profile', async () => {
    const { fake, client } = setup('converged');
    const actions = await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(changes(actions)).toEqual([]);
    expect(fake.mutations).toEqual([]);
    expect(fake.calls.some((c) => c.path.includes('page%5Bnumber%5D=2') || c.path.includes('page[number]=2'))).toBe(true);
  });

  it('repairs drift on all four resources, then settles', async () => {
    const { fake, client } = setup('drifted');
    const first = await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(first.map((a) => `${a.change} ${a.resource}`)).toEqual([
      'update outbound-voice-profile', 'update fqdn-connection', 'update fqdn', 'update credential-connection',
    ]);
    expect(fake.state.fqdn_connections[0]).toMatchObject({ active: true, transport_protocol: 'TCP', inbound: { ani_number_format: '+E.164', dnis_number_format: '+e164' } });
    expect(fake.state.credential_connections[0]).toMatchObject({ user_name: SIP_USER, outbound: { outbound_voice_profile_id: '1000000000000000003' } });
    fake.clearCalls();
    const second = await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(changes(second)).toEqual([]);
    expect(fake.mutations).toEqual([]);
  });

  it('does not send the password on updates unless asked to rotate', async () => {
    const { fake, client } = setup('drifted');
    await reconcileTelnyx(client, buildDesired(settings), { dryRun: false });
    expect(JSON.stringify(fake.mutations.filter((c) => c.method === 'PATCH').map((c) => c.body))).not.toContain(SIP_PASS);
  });

  it('--rotate-credentials re-sends the credential connection even when it looks converged', async () => {
    const { fake, client } = setup('converged');
    const actions = await reconcileTelnyx(client, buildDesired({ ...settings, rotateCredentials: true }), { dryRun: false });
    expect(changes(actions).map((a) => a.resource)).toEqual(['credential-connection']);
    expect(fake.mutations).toHaveLength(1);
    expect((fake.mutations[0]?.body as Record<string, unknown>).password).toBe(SIP_PASS);
  });

  it('refuses to guess when two connections share the managed name', async () => {
    const { client } = setup('duplicate-names');
    await expect(reconcileTelnyx(client, buildDesired(settings), { dryRun: false })).rejects.toThrow(/more than one.*1145-dev-livekit-inbound/i);
  });

  it('surfaces a rejected key without echoing it', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const client = new TelnyxClient('some-wrong-key', fake.fetch);
    const err = await reconcileTelnyx(client, buildDesired(settings), { dryRun: true }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain('some-wrong-key');
  });
});

describe('main (CLI)', () => {
  const env = { TELNYX_API_KEY: API_KEY, TELNYX_SIP_USERNAME: SIP_USER, TELNYX_SIP_PASSWORD: SIP_PASS, LIVEKIT_URL: 'wss://fixture-proj.livekit.cloud' };
  const run = async (argv: string[], e: Record<string, string | undefined>, fake: FakeTelnyx) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, e, { out: (s) => out.push(s), err: (s) => err.push(s) }, fake.fetch);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('names missing environment variables and calls nothing', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const r = await run([], { LIVEKIT_URL: env.LIVEKIT_URL }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toContain('TELNYX_API_KEY');
    expect(r.err).toContain('TELNYX_SIP_PASSWORD');
    expect(fake.calls).toEqual([]);
  });

  it('asks for --sip-host when LIVEKIT_URL is not a LiveKit Cloud URL', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const r = await run([], { ...env, LIVEKIT_URL: 'ws://localhost:7880' }, fake);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--sip-host');
  });

  it('dry run prints the plan, hides secrets and writes nothing', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const r = await run(['--dry-run'], env, fake);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toContain('1145-dev-livekit-inbound');
    for (const s of [API_KEY, SIP_PASS]) expect(r.out + r.err).not.toContain(s);
    expect(fake.mutations).toEqual([]);
  });

  it('prints TELNYX_CONNECTION_ID for the FQDN connection and reports no changes on the second run', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const first = await run([], env, fake);
    const id = (fake.state.fqdn_connections[0] as Record<string, string>).id;
    expect(first.code).toBe(0);
    expect(first.out).toContain(`TELNYX_CONNECTION_ID=${id}`);
    for (const s of [API_KEY, SIP_PASS]) expect(first.out + first.err).not.toContain(s);
    fake.clearCalls();
    const second = await run([], env, fake);
    expect(second.out).toMatch(/no changes/i);
    expect(second.out).toContain(`TELNYX_CONNECTION_ID=${id}`);
    expect(fake.mutations).toEqual([]);
  });

  it('accepts an explicit --sip-host and --daily-spend-limit', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const r = await run(['--sip-host', 'sip.example.test', '--daily-spend-limit', '10'], { ...env, LIVEKIT_URL: undefined }, fake);
    expect(r.code).toBe(0);
    expect(fake.state.fqdns[0]).toMatchObject({ fqdn: 'sip.example.test' });
    expect(fake.state.outbound_voice_profiles[0]).toMatchObject({ daily_spend_limit: '10.00' });
  });

  it('rejects unknown flags', async () => {
    const fake = new FakeTelnyx(fixture('empty'), API_KEY);
    const r = await run(['--dryrun'], env, fake);
    expect(r.code).toBe(2);
  });
});
