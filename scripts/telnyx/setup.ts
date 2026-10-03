/**
 * Idempotent Telnyx setup for the voice path (E1). Creates or repairs, never deletes:
 *   outbound voice profile -> FQDN connection (inbound, points at LiveKit SIP) + its FQDN -> credential connection (outbound).
 * It does not search, order or assign numbers; provisioning (services/provisioning) assigns each DID to the FQDN connection.
 *
 * Run: pnpm tsx scripts/telnyx/setup.ts [--dry-run] [--stage dev] [--sip-host <host>] [--transport TCP] [--daily-spend-limit 25] [--rotate-credentials]
 * Credentials come only from the environment names in docs/API_KEYS.md and are never printed.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { TelnyxClient, type FetchLike, type Row } from './api.js';

export interface TelnyxSettings {
  stage: string;
  sipHost: string;
  sipUsername: string;
  sipPassword: string;
  transport?: 'TCP' | 'UDP' | 'TLS';
  /** USD per day on the outbound voice profile. Unset = leave the profile's limit alone. */
  dailySpendLimit?: number;
  rotateCredentials?: boolean;
}

export interface Desired {
  profile: { name: string; whitelisted_destinations: string[]; dailySpendLimit?: number };
  fqdnConnection: { name: string; transport: string; inbound: { ani_number_format: string; dnis_number_format: string } };
  fqdn: { fqdn: string; port: number; dns_record_type: string };
  credentialConnection: { name: string; userName: string; password: string; rotate: boolean };
}

export type Resource = 'outbound-voice-profile' | 'fqdn-connection' | 'fqdn' | 'credential-connection';
export interface Action { change: 'create' | 'update' | 'noop'; resource: Resource; name: string; id?: string; fields?: string[] }

/** `wss://proj.livekit.cloud` -> `proj.sip.livekit.cloud`. Null when the URL is not a LiveKit Cloud project. */
export function sipHostFromLivekitUrl(url: string): string | null {
  const m = /^(?:wss?|https?):\/\/([a-z0-9-]+)\.livekit\.cloud\/?$/i.exec(url.trim());
  return m ? `${(m[1] as string).toLowerCase()}.sip.livekit.cloud` : null;
}

export function buildDesired(s: TelnyxSettings): Desired {
  return {
    profile: { name: `1145-${s.stage}-outbound`, whitelisted_destinations: ['US', 'CA'], dailySpendLimit: s.dailySpendLimit },
    // E.164 on both sides: the worker reads sip.trunkPhoneNumber (dialed) and the resolver keys on it.
    fqdnConnection: { name: `1145-${s.stage}-livekit-inbound`, transport: s.transport ?? 'TCP', inbound: { ani_number_format: '+E.164', dnis_number_format: '+e164' } },
    fqdn: { fqdn: s.sipHost.toLowerCase(), port: 5060, dns_record_type: 'a' },
    credentialConnection: { name: `1145-${s.stage}-livekit-outbound`, userName: s.sipUsername, password: s.sipPassword, rotate: s.rotateCredentials ?? false },
  };
}

function findOne(rows: Row[], key: string, name: string, label: string): Row | undefined {
  const hits = rows.filter((r) => r[key] === name);
  if (hits.length > 1) throw new Error(`Found more than one ${label} named ${name} in Telnyx. Remove the extra ones in the portal, then run again.`);
  return hits[0];
}
const sorted = (xs: unknown) => JSON.stringify([...((xs as string[] | undefined) ?? [])].sort());

export async function reconcileTelnyx(client: TelnyxClient, d: Desired, opts: { dryRun: boolean }): Promise<Action[]> {
  const actions: Action[] = [];
  const [profiles, fqdnConns, fqdns, credConns] = await Promise.all([
    client.list('outbound_voice_profiles'), client.list('fqdn_connections'), client.list('fqdns'), client.list('credential_connections'),
  ]);

  // 1. Outbound voice profile (required before a connection can place calls; carries the spend limit)
  const limit = d.profile.dailySpendLimit;
  const profileBody = {
    name: d.profile.name, traffic_type: 'conversational', service_plan: 'global', enabled: true,
    whitelisted_destinations: d.profile.whitelisted_destinations,
    ...(limit !== undefined ? { daily_spend_limit: limit.toFixed(2), daily_spend_limit_enabled: true } : {}),
  };
  const profile = findOne(profiles, 'name', d.profile.name, 'outbound voice profile');
  let profileId = (profile?.id as string | undefined) ?? '(new outbound voice profile)';
  if (!profile) {
    if (!opts.dryRun) profileId = (await client.create('outbound_voice_profiles', profileBody)).id;
    actions.push({ change: 'create', resource: 'outbound-voice-profile', name: d.profile.name, id: opts.dryRun ? undefined : profileId });
  } else {
    const fields: string[] = [];
    if (sorted(profile.whitelisted_destinations) !== sorted(d.profile.whitelisted_destinations)) fields.push('whitelisted_destinations');
    if (profile.enabled === false) fields.push('enabled');
    if (limit !== undefined && (Number(profile.daily_spend_limit) !== limit || profile.daily_spend_limit_enabled !== true)) fields.push('daily_spend_limit');
    if (fields.length && !opts.dryRun) await client.update('outbound_voice_profiles', profileId, profileBody);
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'outbound-voice-profile', name: d.profile.name, id: profileId, fields });
  }

  // 2. FQDN connection: inbound calls for every DID assigned to it go to LiveKit SIP
  const connBody = { connection_name: d.fqdnConnection.name, active: true, transport_protocol: d.fqdnConnection.transport, inbound: d.fqdnConnection.inbound };
  const conn = findOne(fqdnConns, 'connection_name', d.fqdnConnection.name, 'FQDN connection');
  let connId = (conn?.id as string | undefined) ?? '(new FQDN connection)';
  if (!conn) {
    if (!opts.dryRun) connId = (await client.create('fqdn_connections', connBody)).id;
    actions.push({ change: 'create', resource: 'fqdn-connection', name: d.fqdnConnection.name, id: opts.dryRun ? undefined : connId });
  } else {
    const fields: string[] = [];
    if (conn.active !== true) fields.push('active');
    if (conn.transport_protocol !== d.fqdnConnection.transport) fields.push('transport_protocol');
    if (conn.inbound?.ani_number_format !== d.fqdnConnection.inbound.ani_number_format) fields.push('inbound.ani_number_format');
    if (conn.inbound?.dnis_number_format !== d.fqdnConnection.inbound.dnis_number_format) fields.push('inbound.dnis_number_format');
    if (fields.length && !opts.dryRun) await client.update('fqdn_connections', connId, connBody);
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'fqdn-connection', name: d.fqdnConnection.name, id: connId, fields });
  }

  // 3. The FQDN entry (LiveKit SIP host) on that connection. Other entries someone added by hand are left alone.
  const fqdnBody = { connection_id: connId, fqdn: d.fqdn.fqdn, port: d.fqdn.port, dns_record_type: d.fqdn.dns_record_type };
  const entry = fqdns.find((f) => f.connection_id === connId && String(f.fqdn).toLowerCase() === d.fqdn.fqdn);
  if (!entry) {
    let id: string | undefined;
    if (!opts.dryRun) id = (await client.create('fqdns', fqdnBody)).id;
    actions.push({ change: 'create', resource: 'fqdn', name: d.fqdn.fqdn, id });
  } else {
    const fields: string[] = [];
    if (entry.port !== d.fqdn.port) fields.push('port');
    if (entry.dns_record_type !== d.fqdn.dns_record_type) fields.push('dns_record_type');
    if (fields.length && !opts.dryRun) await client.update('fqdns', entry.id as string, { fqdn: d.fqdn.fqdn, port: d.fqdn.port, dns_record_type: d.fqdn.dns_record_type });
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'fqdn', name: d.fqdn.fqdn, id: entry.id, fields });
  }

  // 4. Credential connection: LiveKit's outbound trunk authenticates with this user and password
  const cc = d.credentialConnection;
  const cred = findOne(credConns, 'connection_name', cc.name, 'credential connection');
  const credBase = { connection_name: cc.name, user_name: cc.userName, active: true, outbound: { outbound_voice_profile_id: profileId } };
  if (!cred) {
    let id: string | undefined;
    if (!opts.dryRun) id = (await client.create('credential_connections', { ...credBase, password: cc.password })).id;
    actions.push({ change: 'create', resource: 'credential-connection', name: cc.name, id });
  } else {
    const fields: string[] = [];
    if (cred.user_name !== cc.userName) fields.push('user_name');
    if (cred.active !== true) fields.push('active');
    if (cred.outbound?.outbound_voice_profile_id !== profileId) fields.push('outbound.outbound_voice_profile_id');
    if (cc.rotate) fields.push('password');
    // The password is only sent when it is being rotated (Telnyx never returns it, so it cannot be compared).
    if (fields.length && !opts.dryRun) await client.update('credential_connections', cred.id as string, cc.rotate ? { ...credBase, password: cc.password } : credBase);
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'credential-connection', name: cc.name, id: cred.id, fields });
  }
  return actions;
}

export interface Io { out: (line: string) => void; err: (line: string) => void }

const USAGE = 'Usage: setup.ts [--dry-run] [--stage dev] [--sip-host <host>] [--transport TCP|UDP|TLS] [--daily-spend-limit <usd>] [--rotate-credentials]';

function describeAction(a: Action, dryRun: boolean): string {
  const verb = a.change === 'noop' ? 'ok      ' : dryRun ? `would ${a.change}`.padEnd(8) : `${a.change}d`.padEnd(8);
  return `${verb} ${a.resource} ${a.name}${a.id ? ` [${a.id}]` : ''}${a.fields?.length ? ` (${a.fields.join(', ')})` : ''}`;
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io, fetchImpl?: FetchLike): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true,
      options: {
        'dry-run': { type: 'boolean', default: false }, stage: { type: 'string', default: 'dev' }, 'sip-host': { type: 'string' },
        transport: { type: 'string', default: 'TCP' }, 'daily-spend-limit': { type: 'string' }, 'rotate-credentials': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
      },
    }));
  } catch (e) { io.err(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (values.help) { io.out(USAGE); return 0; }

  const missing = ['TELNYX_API_KEY', 'TELNYX_SIP_USERNAME', 'TELNYX_SIP_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) { io.err(`Missing environment variables: ${missing.join(', ')}. See docs/API_KEYS.md.`); return 2; }
  const sipHost = values['sip-host'] ?? (env.LIVEKIT_URL ? sipHostFromLivekitUrl(env.LIVEKIT_URL) : null);
  if (!sipHost) { io.err('Could not work out the LiveKit SIP host from LIVEKIT_URL. Pass --sip-host <project>.sip.livekit.cloud.'); return 2; }
  const transport = String(values.transport).toUpperCase();
  if (!['TCP', 'UDP', 'TLS'].includes(transport)) { io.err(`--transport must be TCP, UDP or TLS.\n${USAGE}`); return 2; }
  const limitRaw = values['daily-spend-limit'];
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !(limit > 0)) { io.err('--daily-spend-limit must be a positive number of US dollars.'); return 2; }

  const dryRun = values['dry-run'] === true;
  const desired = buildDesired({
    stage: values.stage as string, sipHost, sipUsername: env.TELNYX_SIP_USERNAME as string, sipPassword: env.TELNYX_SIP_PASSWORD as string,
    transport: transport as 'TCP' | 'UDP' | 'TLS', dailySpendLimit: limit, rotateCredentials: values['rotate-credentials'] === true,
  });
  try {
    const actions = await reconcileTelnyx(new TelnyxClient(env.TELNYX_API_KEY as string, fetchImpl), desired, { dryRun });
    if (dryRun) io.out('Dry run: reading Telnyx only, nothing will be changed.');
    for (const a of actions) io.out(describeAction(a, dryRun));
    const changed = actions.filter((a) => a.change !== 'noop').length;
    io.out(changed === 0 ? 'No changes needed.' : dryRun ? `${changed} change(s) would be made.` : `${changed} change(s) made.`);
    const connId = actions.find((a) => a.resource === 'fqdn-connection')?.id;
    if (connId) io.out(`TELNYX_CONNECTION_ID=${connId}`);
    return 0;
  } catch (e) { io.err((e as Error).message); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((c) => process.exit(c));
}
