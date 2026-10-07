import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, makeEvent, type EventEnvelope } from '@1145/shared';

/**
 * Step: emit-status
 * Publish `onboarding.status` so the chat and the dashboard can say what is happening ("your number is ready").
 *
 * Two writes, in this order, so anything that sees the event can also read the same words from the status API:
 *   1. the latest status for the step, at ONBOARDING#<onboardingId> / STATUS#<step>
 *   2. the `onboarding.status` envelope on the 1145 bus (source 1145.provisioning)
 *
 * Every line the owner reads comes from the catalog below, never from the caller, so it is written once, checked by
 * @1145/conversation-style in CI (scripts/ci/check-style.ts picks up each `messageForOwner:` literal) and cannot be
 * steered by scraped or owner-typed text. The one value the owner chose, the agent's name, is vetted before it is used.
 * The tenant comes from the workflow state the start endpoint set, never from model output (1145-tenant-isolation).
 */

export const STATUS_STEPS = ['number', 'knowledge', 'profile', 'agent_name', 'smoke_call', 'activate'] as const;
export const STATUS_STATES = ['started', 'waiting_owner', 'done', 'failed'] as const;
export type StatusStep = (typeof STATUS_STEPS)[number];
export type StatusState = (typeof STATUS_STATES)[number];
/** Picks a variant of the line for the same step and state. `no_name` is chosen automatically when there is no usable name. */
export type StatusReason = 'retry' | 'no_name' | 'not_reached' | 'no_owner_phone' | 'owner_phone_not_allowed';

interface CopyEntry { step: StatusStep; state: StatusState; reason?: StatusReason; messageForOwner: string }

/** Short, plain, first person, nothing scripted. See .claude/skills/1145-conversation-style. `{agentName}` is filled in below. */
export const STATUS_COPY: readonly CopyEntry[] = [
  { step: 'number', state: 'started', messageForOwner: 'Finding you a local number now.' },
  { step: 'number', state: 'done', messageForOwner: 'Your new number is ready.' },
  { step: 'number', state: 'failed', messageForOwner: "I couldn't get you a number just yet. Our team has the details and will be in touch." },

  { step: 'knowledge', state: 'started', messageForOwner: 'Reading through your website for the details.' },
  { step: 'knowledge', state: 'waiting_owner', messageForOwner: "I found some details on your site. Have a look and tell me what's right." },
  { step: 'knowledge', state: 'done', messageForOwner: 'Got it, those details are saved.' },
  { step: 'knowledge', state: 'failed', messageForOwner: "I couldn't read your website, so I'll go with what you've told me." },

  { step: 'profile', state: 'waiting_owner', messageForOwner: 'I still need your hours and services to finish setting up.' },
  { step: 'profile', state: 'done', messageForOwner: 'Your hours and services are all set.' },

  { step: 'agent_name', state: 'waiting_owner', messageForOwner: 'What would you like to call your receptionist?' },
  { step: 'agent_name', state: 'done', messageForOwner: 'Great, {agentName} it is.' },
  { step: 'agent_name', state: 'done', reason: 'no_name', messageForOwner: 'Great, that name works.' },

  { step: 'smoke_call', state: 'started', messageForOwner: 'Calling your phone now. Pick up when it rings and say hi.' },
  { step: 'smoke_call', state: 'started', reason: 'retry', messageForOwner: "That one didn't connect. Trying again, so keep your phone close." },
  { step: 'smoke_call', state: 'done', messageForOwner: 'That worked, the test call came through fine.' },
  { step: 'smoke_call', state: 'failed', reason: 'not_reached', messageForOwner: "I couldn't get through on the test call, so your line isn't live yet. Someone from our team will look into it and get in touch." },
  { step: 'smoke_call', state: 'failed', reason: 'no_owner_phone', messageForOwner: "I don't have a phone number to test with, so your line isn't live yet. Someone from our team will reach out to finish up." },
  { step: 'smoke_call', state: 'failed', reason: 'owner_phone_not_allowed', messageForOwner: "I can't place the test call to that number, so your line isn't live yet. Someone from our team will reach out to sort it out." },

  { step: 'activate', state: 'started', messageForOwner: 'Switching your line on now.' },
  { step: 'activate', state: 'done', messageForOwner: "You're live! Calls to your new number now go to {agentName}." },
  { step: 'activate', state: 'done', reason: 'no_name', messageForOwner: "You're live! Your new number is answering calls now." },
  { step: 'activate', state: 'failed', messageForOwner: 'Something got in the way of switching you on. Our team has been told and will sort it out.' },
];

export class UnknownStatusError extends Error {
  constructor(what: string) { super(`UnknownStatus: no owner message for ${what}`); this.name = 'UnknownStatus'; }
}

const isStep = (v: unknown): v is StatusStep => (STATUS_STEPS as readonly unknown[]).includes(v);
const isState = (v: unknown): v is StatusState => (STATUS_STATES as readonly unknown[]).includes(v);

/** A first name or a short nickname: letters, digits, spaces, apostrophes, hyphens; at most three words. Anything else is dropped. */
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} '’-]{0,22}[\p{L}\p{N}])?$/u;
export function vettedName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/ {2,}/g, ' ');
  return NAME_RE.test(name) && name.split(' ').length <= 3 ? name : undefined;
}

export interface StatusQuery { step: unknown; state: unknown; reason?: unknown; agentName?: unknown }
interface ResolvedStatus { step: StatusStep; state: StatusState; messageForOwner: string }

function resolve(q: StatusQuery): ResolvedStatus {
  const label = `${String(q.step)}/${String(q.state)}${q.reason ? `/${String(q.reason)}` : ''}`;
  if (!isStep(q.step) || !isState(q.state)) throw new UnknownStatusError(label);
  const { step, state } = q;
  const reason = q.reason === undefined || q.reason === '' ? undefined : q.reason;
  const exact = STATUS_COPY.find((c) => c.step === step && c.state === state && c.reason === reason);
  if (!exact) throw new UnknownStatusError(label);
  if (!exact.messageForOwner.includes('{agentName}')) return { step, state, messageForOwner: exact.messageForOwner };
  const name = vettedName(q.agentName);
  if (name) return { step, state, messageForOwner: exact.messageForOwner.replace('{agentName}', name) };
  const plain = STATUS_COPY.find((c) => c.step === step && c.state === state && c.reason === 'no_name');
  if (!plain) throw new UnknownStatusError(`${label} (no name)`);
  return { step, state, messageForOwner: plain.messageForOwner };
}

/** The words for one step and state. Throws UnknownStatusError rather than sending a blank or invented line. */
export function statusMessage(q: StatusQuery): string {
  return resolve(q).messageForOwner;
}

/** Onboarding ids are minted by the router (`o_<hex>`); '#' would let a value walk into another key. */
const ONBOARDING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function assertOnboardingId(v: unknown): string {
  if (typeof v !== 'string' || !ONBOARDING_ID_RE.test(v)) throw new Error('invalid onboarding id');
  return v;
}

export interface StatusRow { step: StatusStep; state: StatusState; messageForOwner: string; updatedAt: string; tenantId: string }
export interface StatusDeps {
  saveLatest(onboardingId: string, row: StatusRow): Promise<void>;
  publish(event: EventEnvelope): Promise<void>;
  now?: () => Date;
}
export interface EmitStatusInput { onboardingId: string; tenantId: string; step: string; state: string; reason?: string; agentName?: string }
export interface EmitStatusResult { step: StatusStep; state: StatusState; messageForOwner: string }

export async function emitStatus(input: EmitStatusInput, deps: StatusDeps): Promise<EmitStatusResult> {
  const onboardingId = assertOnboardingId(input?.onboardingId);
  const tenantId = asTenantId(String(input?.tenantId ?? ''));
  const status = resolve({ step: input.step, state: input.state, reason: input.reason, agentName: input.agentName });
  const now = (deps.now ?? (() => new Date()))();

  await deps.saveLatest(onboardingId, { ...status, updatedAt: now.toISOString(), tenantId });
  await deps.publish(makeEvent('onboarding.status', { tenantId, correlationId: onboardingId }, {
    step: status.step, state: status.state, messageForOwner: status.messageForOwner,
  }, now));
  return status;
}

// ── AWS wiring (the only part that is not a pure function of its deps) ─────────────────────────────────────────

export interface DocClient { send(command: any): Promise<any> }
const STATUS_TTL_SECONDS = 30 * 24 * 3600;

/** ONBOARDING#<id> / STATUS#<step>: the newest status per step, for the status API to merge into progress lines. */
export function ddbStatusStore(client: DocClient, table: string, now: () => Date = () => new Date()): StatusDeps['saveLatest'] {
  return async (onboardingId, row) => {
    await client.send(new PutCommand({
      TableName: table,
      Item: {
        PK: `ONBOARDING#${assertOnboardingId(onboardingId)}`, SK: `STATUS#${row.step}`, ...row,
        ttl: Math.floor(now().getTime() / 1000) + STATUS_TTL_SECONDS,
      },
    }));
  };
}

/** PutEvents on the 1145 bus. A rejected entry is a failure, so the Step Functions retry sends it again. */
export function eventBridgePublisher(client: DocClient, busName: string, source = '1145.provisioning'): StatusDeps['publish'] {
  return async (event) => {
    const out = await client.send(new PutEventsCommand({
      Entries: [{ EventBusName: busName, Source: source, DetailType: event.type, Detail: JSON.stringify(event) }],
    }));
    if (out?.FailedEntryCount) throw new Error(`eventbridge rejected ${event.type}`);
  };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

let memo: { doc: DocClient; eb: DocClient } | undefined;
/** Built on first use so importing a step (tests, bundling) never needs credentials or a region. */
export function awsClients(): { doc: DocClient; eb: DocClient } {
  memo ??= {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    eb: new EventBridgeClient({}),
  };
  return memo;
}

/** Status deps for the Lambda entries: DynamoDB latest-status item plus the 1145 bus. */
export function statusDepsFromEnv(): StatusDeps {
  const table = requireEnv('TABLE_NAME');
  const bus = requireEnv('EVENT_BUS_NAME');
  const { doc, eb } = awsClients();
  return { saveLatest: ddbStatusStore(doc, table), publish: eventBridgePublisher(eb, bus) };
}

/**
 * Step Functions entry. The workflow passes its own state plus the step and state to report, for example
 * `{ onboardingId, tenantId, step: 'number', state: 'done' }`. Failures throw so the state's retry sends it again.
 */
export async function handler(event: EmitStatusInput): Promise<EmitStatusResult> {
  const deps = statusDepsFromEnv();
  return emitStatus(event, deps);
}
