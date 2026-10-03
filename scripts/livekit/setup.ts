/**
 * Idempotent LiveKit SIP setup for the voice path (E1):
 *   inbound trunk (every number on the Telnyx connection) -> dispatch rule (one room per call, agent "frontdesk")
 *   outbound trunk (Telnyx credential connection) for transfers and smoke calls.
 *
 * Run: pnpm tsx scripts/livekit/setup.ts [--dry-run] [--stage dev] [--rotate-credentials] [--allowed-addresses a,b]
 * Credentials come only from the environment names in docs/API_KEYS.md and are never printed.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LivekitSipClient, type DispatchRule, type FetchLike, type InboundTrunk, type OutboundTrunk } from './api.js';

export interface LivekitSettings {
  stage: string;
  sipUsername: string;
  sipPassword: string;
  /** Re-send the outbound trunk even when nothing visible changed (LiveKit does not echo the password back). */
  rotateCredentials?: boolean;
  /** Restrict the inbound trunk to these source addresses (Telnyx signaling IPs). Empty = any source. */
  allowedAddresses?: string[];
  agentName?: string;
  roomPrefix?: string;
  telnyxAddress?: string;
}

export interface Desired {
  inbound: { name: string; numbers: string[]; allowedAddresses: string[] };
  outbound: { name: string; address: string; transport: string; numbers: string[]; authUsername: string; authPassword: string; rotate: boolean };
  dispatch: { name: string; roomPrefix: string; agentName: string };
}

export type Resource = 'inbound-trunk' | 'outbound-trunk' | 'dispatch-rule';
export interface Action { change: 'create' | 'update' | 'noop'; resource: Resource; name: string; id?: string; fields?: string[] }

const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();
const same = (a: string[] | undefined, b: string[] | undefined) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export function buildDesired(s: LivekitSettings): Desired {
  return {
    // Empty numbers means the trunk accepts any dialed number, so every DID assigned to the Telnyx connection works.
    inbound: { name: `1145-${s.stage}-telnyx-inbound`, numbers: [], allowedAddresses: s.allowedAddresses ?? [] },
    outbound: {
      name: `1145-${s.stage}-telnyx-outbound`, address: s.telnyxAddress ?? 'sip.telnyx.com', transport: 'SIP_TRANSPORT_AUTO',
      numbers: ['*'], authUsername: s.sipUsername, authPassword: s.sipPassword, rotate: s.rotateCredentials ?? false,
    },
    dispatch: { name: `1145-${s.stage}-frontdesk`, roomPrefix: s.roomPrefix ?? 'call-', agentName: s.agentName ?? 'frontdesk' },
  };
}

/** Find the one resource with this name. Two with the same name means a human edited the project: stop, don't guess. */
function findOne<T extends { name?: string }>(items: T[], name: string, label: string): T | undefined {
  const hits = items.filter((i) => i.name === name);
  if (hits.length > 1) throw new Error(`Found more than one ${label} named ${name}. Remove the extra ones in the LiveKit dashboard, then run again.`);
  return hits[0];
}

function inboundPayload(d: Desired['inbound']): InboundTrunk {
  return { name: d.name, numbers: d.numbers, allowedAddresses: d.allowedAddresses };
}
function outboundPayload(d: Desired['outbound']): OutboundTrunk {
  return { name: d.name, address: d.address, transport: d.transport, numbers: d.numbers, authUsername: d.authUsername, authPassword: d.authPassword };
}
function dispatchPayload(d: Desired['dispatch'], inboundId: string): DispatchRule {
  return {
    name: d.name,
    rule: { dispatchRuleIndividual: { roomPrefix: d.roomPrefix } },
    trunkIds: [inboundId],
    roomConfig: { agents: [{ agentName: d.agentName }] },
  };
}

export async function reconcileLivekit(client: LivekitSipClient, desired: Desired, opts: { dryRun: boolean }): Promise<Action[]> {
  const actions: Action[] = [];
  const [inbounds, outbounds, rules] = await Promise.all([client.listInbound(), client.listOutbound(), client.listDispatchRules()]);

  // Inbound trunk
  const inExisting = findOne(inbounds, desired.inbound.name, 'inbound trunk');
  let inboundId = inExisting?.sipTrunkId ?? '(new inbound trunk)';
  if (!inExisting) {
    if (!opts.dryRun) inboundId = (await client.createInbound(inboundPayload(desired.inbound))).sipTrunkId ?? inboundId;
    actions.push({ change: 'create', resource: 'inbound-trunk', name: desired.inbound.name, id: opts.dryRun ? undefined : inboundId });
  } else {
    const fields: string[] = [];
    if (!same(inExisting.numbers, desired.inbound.numbers)) fields.push('numbers');
    if (!same(inExisting.allowedAddresses, desired.inbound.allowedAddresses)) fields.push('allowedAddresses');
    if (fields.length && !opts.dryRun) await client.updateInbound(inboundId, inboundPayload(desired.inbound));
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'inbound-trunk', name: desired.inbound.name, id: inboundId, fields });
  }

  // Outbound trunk
  const outExisting = findOne(outbounds, desired.outbound.name, 'outbound trunk');
  if (!outExisting) {
    let id: string | undefined;
    if (!opts.dryRun) id = (await client.createOutbound(outboundPayload(desired.outbound))).sipTrunkId;
    actions.push({ change: 'create', resource: 'outbound-trunk', name: desired.outbound.name, id });
  } else {
    const fields: string[] = [];
    if (outExisting.address !== desired.outbound.address) fields.push('address');
    if ((outExisting.transport ?? 'SIP_TRANSPORT_AUTO') !== desired.outbound.transport) fields.push('transport');
    if (!same(outExisting.numbers, desired.outbound.numbers)) fields.push('numbers');
    if (outExisting.authUsername !== desired.outbound.authUsername) fields.push('authUsername');
    if (desired.outbound.rotate) fields.push('authPassword');
    if (fields.length && !opts.dryRun) await client.updateOutbound(outExisting.sipTrunkId as string, outboundPayload(desired.outbound));
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'outbound-trunk', name: desired.outbound.name, id: outExisting.sipTrunkId, fields });
  }

  // Dispatch rule
  const ruleExisting = findOne(rules, desired.dispatch.name, 'dispatch rule');
  if (!ruleExisting) {
    let id: string | undefined;
    if (!opts.dryRun) id = (await client.createDispatchRule(dispatchPayload(desired.dispatch, inboundId))).sipDispatchRuleId;
    actions.push({ change: 'create', resource: 'dispatch-rule', name: desired.dispatch.name, id });
  } else {
    const fields: string[] = [];
    const individual = ruleExisting.rule?.dispatchRuleIndividual;
    if (!individual || individual.roomPrefix !== desired.dispatch.roomPrefix) fields.push('rule');
    if (!same(ruleExisting.trunkIds, [inboundId])) fields.push('trunkIds');
    if (!same((ruleExisting.roomConfig?.agents ?? []).map((a) => a.agentName ?? ''), [desired.dispatch.agentName])) fields.push('roomConfig.agents');
    if (fields.length && !opts.dryRun) await client.updateDispatchRule(ruleExisting.sipDispatchRuleId as string, dispatchPayload(desired.dispatch, inboundId));
    actions.push({ change: fields.length ? 'update' : 'noop', resource: 'dispatch-rule', name: desired.dispatch.name, id: ruleExisting.sipDispatchRuleId, fields });
  }
  return actions;
}

export interface Io { out: (line: string) => void; err: (line: string) => void }

const REQUIRED_ENV = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'TELNYX_SIP_USERNAME', 'TELNYX_SIP_PASSWORD'] as const;

export function describeAction(a: Action, dryRun: boolean): string {
  const verb = a.change === 'noop' ? 'ok      ' : dryRun ? `would ${a.change}`.padEnd(8) : `${a.change}d`.padEnd(8);
  const detail = a.fields?.length ? ` (${a.fields.join(', ')})` : '';
  return `${verb} ${a.resource} ${a.name}${a.id ? ` [${a.id}]` : ''}${detail}`;
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io, fetchImpl?: FetchLike): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true,
      options: {
        'dry-run': { type: 'boolean', default: false }, stage: { type: 'string', default: 'dev' },
        'rotate-credentials': { type: 'boolean', default: false }, 'allowed-addresses': { type: 'string' }, help: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    io.err(`${(e as Error).message}\nUsage: setup.ts [--dry-run] [--stage dev] [--rotate-credentials] [--allowed-addresses a,b]`);
    return 2;
  }
  if (values.help) { io.out('Usage: setup.ts [--dry-run] [--stage dev] [--rotate-credentials] [--allowed-addresses a,b]'); return 0; }

  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) { io.err(`Missing environment variables: ${missing.join(', ')}. See docs/API_KEYS.md.`); return 2; }

  const dryRun = values['dry-run'] === true;
  const desired = buildDesired({
    stage: values.stage as string, sipUsername: env.TELNYX_SIP_USERNAME as string, sipPassword: env.TELNYX_SIP_PASSWORD as string,
    rotateCredentials: values['rotate-credentials'] === true,
    allowedAddresses: values['allowed-addresses'] ? values['allowed-addresses'].split(',').map((s) => s.trim()).filter(Boolean) : [],
  });
  const client = new LivekitSipClient(env.LIVEKIT_URL as string, env.LIVEKIT_API_KEY as string, env.LIVEKIT_API_SECRET as string, fetchImpl);
  try {
    const actions = await reconcileLivekit(client, desired, { dryRun });
    if (dryRun) io.out('Dry run: reading LiveKit only, nothing will be changed.');
    for (const a of actions) io.out(describeAction(a, dryRun));
    const changed = actions.filter((a) => a.change !== 'noop').length;
    io.out(changed === 0 ? 'No changes needed.' : dryRun ? `${changed} change(s) would be made.` : `${changed} change(s) made.`);
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((c) => process.exit(c));
}
