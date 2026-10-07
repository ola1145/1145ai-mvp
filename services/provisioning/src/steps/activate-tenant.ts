import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, makeEvent, maskPhone, type EngineId, type EventEnvelope } from '@1145/shared';
import { assertOnboardingId, awsClients, emitStatus, eventBridgePublisher, requireEnv, ddbStatusStore, type DocClient, type StatusDeps } from './emit-status.js';

/**
 * Step: activate-tenant
 * The last step: the tenant goes live.
 *
 *   1. Gate: only a passed smoke call switches a line on (the smoke call is the go-live test).
 *   2. PROFILE.state -> active (plus the number and engine the console needs). Never from suspended or over_cap:
 *      ops may have paused the tenant while onboarding ran, and activation must not undo that.
 *   3. Flip the owner's IDENTITY route from onboarding to the tenant (role owner, tid, tenantState active), so the
 *      next chat message from the owner reaches the copilot instead of the onboarding agent. The flip only touches the
 *      route that started THIS onboarding (or one already flipped to this tenant), never somebody else's.
 *   4. Emit `tenant.provisioned` (owner notification: "You're live").
 *   5. Tell the owner in chat (best effort; a hiccup here never undoes a successful activation).
 *
 * Every write is idempotent, so a Step Functions retry repeats the same final state. There are no async channel
 * unlocks to submit: ADR-0005 removed WhatsApp, 10DLC and every other approval-gated channel from the MVP, so the old
 * "submit 10DLC brand / WABA as separate executions" step no longer exists.
 *
 * Identity: tenantId and onboardingId come from the workflow state the start endpoint wrote; the owner's channel
 * identity is read from the ONBOARDING# record the router wrote when the owner first messaged us; the number route
 * must already point at this tenant. Nothing here is taken from model output.
 */

export class SmokeCallNotPassedError extends Error {
  constructor() { super('SmokeCallNotPassed: the smoke call has not passed, so the line stays off'); this.name = 'SmokeCallNotPassed'; }
}
export class OnboardingNotFoundError extends Error {
  constructor() { super('OnboardingNotFound: no onboarding record to take the owner identity from'); this.name = 'OnboardingNotFound'; }
}
export class NumberRouteMismatchError extends Error {
  constructor() { super('NumberRouteMismatch: the ordered number does not route to this tenant'); this.name = 'NumberRouteMismatch'; }
}
export class IdentityRouteConflictError extends Error {
  constructor() { super('IdentityRouteConflict: the owner identity route belongs to another onboarding or tenant'); this.name = 'IdentityRouteConflict'; }
}
export class ProfileNotActivatableError extends Error {
  constructor() { super('ProfileNotActivatable: the profile is missing or not in a state that can go live'); this.name = 'ProfileNotActivatable'; }
}

export interface ActivateInput {
  onboardingId: string;
  tenantId: string;
  number?: { order?: { number?: string }; binding?: { number?: string; engine?: string; agentId?: string } };
  /** RenderAgent output. */
  agent?: { templateVersion?: string };
  /** SmokeCall output. */
  smoke?: { ok?: unknown };
  /** AwaitAgentName output: `{ agentName }`. Only used to word the message. */
  owner?: { agentName?: unknown };
}

export interface ActivateStore {
  /** The channel identity that started this onboarding (ONBOARDING#<id> / STATE), written by the router. */
  getOnboarding(onboardingId: string): Promise<{ channel: string; channelUserId: string } | undefined>;
  getNumberRoute(number: string): Promise<{ tid?: string } | undefined>;
  /** Conditional: the profile must exist and be provisioning or already active. Throws ProfileNotActivatableError. */
  activateProfile(a: { tenantId: string; onboardingId: string; number: string; engine: EngineId; now: Date }): Promise<void>;
  /** Conditional: only the route still carrying this onboardingId (or already this tenant's). Throws IdentityRouteConflictError. */
  flipIdentityRoute(a: { channel: string; channelUserId: string; tenantId: string; onboardingId: string; now: Date }): Promise<void>;
}

export interface ActivateDeps {
  store: ActivateStore;
  publish(event: EventEnvelope): Promise<void>;
  status: StatusDeps;
  now?: () => Date;
}

export interface ActivateResult { activated: true; tenantId: string; engine: EngineId; numberMasked: string; templateVersion?: string }

const ENGINES: readonly EngineId[] = ['livekit-telnyx', 'elevenlabs'];
const E164_RE = /^\+[1-9]\d{6,14}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;

export function parseActivateInput(input: ActivateInput) {
  const onboardingId = assertOnboardingId(input?.onboardingId);
  const tenantId = asTenantId(String(input?.tenantId ?? ''));
  const b = input.number?.binding;
  const engine = ENGINES.find((e) => e === b?.engine);
  if (!engine) throw new Error('activate-tenant: unknown engine in the workflow state');
  const number = b?.number;
  if (typeof number !== 'string' || !E164_RE.test(number)) throw new Error('activate-tenant: the bound number is not E.164');
  const ordered = input.number?.order?.number;
  if (ordered !== undefined && ordered !== number) throw new Error('activate-tenant: the ordered and bound numbers differ');
  if (input.smoke?.ok !== true) throw new SmokeCallNotPassedError();
  const v = input.agent?.templateVersion;
  const templateVersion = typeof v === 'string' && VERSION_RE.test(v) ? v : undefined;
  return { onboardingId, tenantId, engine, number, templateVersion, agentName: input.owner?.agentName };
}

export async function activateTenant(input: ActivateInput, deps: ActivateDeps): Promise<ActivateResult> {
  const { onboardingId, tenantId, engine, number, templateVersion, agentName } = parseActivateInput(input);
  const now = (deps.now ?? (() => new Date()))();

  const owner = await deps.store.getOnboarding(onboardingId);
  if (!owner) throw new OnboardingNotFoundError();
  const route = await deps.store.getNumberRoute(number);
  if (route?.tid !== tenantId) throw new NumberRouteMismatchError();

  await deps.store.activateProfile({ tenantId, onboardingId, number, engine, now });
  await deps.store.flipIdentityRoute({ channel: owner.channel, channelUserId: owner.channelUserId, tenantId, onboardingId, now });

  const numberMasked = maskPhone(number);
  // Last of the writes that matter: if sending fails the retry repeats the idempotent steps above and sends it again.
  await deps.publish(makeEvent('tenant.provisioned', { tenantId, correlationId: onboardingId }, {
    onboardingId, engine, ...(templateVersion ? { templateVersion } : {}), numberMasked,
    phoneNumber: number, // the tenant's own business line; owner notifications word it ("Calls to (214) 555-0142...") per CR C6-2
  }, now));

  await emitStatus({ onboardingId, tenantId, step: 'activate', state: 'done', agentName: typeof agentName === 'string' ? agentName : undefined }, deps.status)
    .catch((err) => console.warn(JSON.stringify({ level: 'warn', step: 'activate-tenant', msg: 'status not sent', onboardingId, err: String(err).slice(0, 160) })));

  return { activated: true, tenantId, engine, numberMasked, ...(templateVersion ? { templateVersion } : {}) };
}

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function ddbActivateStore(client: DocClient, table: string): ActivateStore {
  return {
    async getOnboarding(onboardingId) {
      const out = await client.send(new GetCommand({
        TableName: table, Key: { PK: `ONBOARDING#${assertOnboardingId(onboardingId)}`, SK: 'STATE' }, ConsistentRead: true,
      }));
      const i = out?.Item as { channel?: unknown; channelUserId?: unknown } | undefined;
      return typeof i?.channel === 'string' && typeof i.channelUserId === 'string' ? { channel: i.channel, channelUserId: i.channelUserId } : undefined;
    },

    async getNumberRoute(number) {
      const out = await client.send(new GetCommand({ TableName: table, Key: { PK: keys.numberRoutePk(number), SK: keys.routeSk() }, ConsistentRead: true }));
      const i = out?.Item as { tid?: unknown } | undefined;
      return i ? { ...(typeof i.tid === 'string' ? { tid: i.tid } : {}) } : undefined;
    },

    async activateProfile({ tenantId, onboardingId, number, engine, now }) {
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { PK: keys.tenantPk(asTenantId(tenantId)), SK: keys.profileSk() },
          UpdateExpression: 'SET #state = :active, activatedAt = if_not_exists(activatedAt, :now), #numbers = :nums, #engine = :engine, activatedFrom = :ob',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(#state) OR #state = :provisioning OR #state = :active)',
          ExpressionAttributeNames: { '#state': 'state', '#numbers': 'numbers', '#engine': 'engine' },
          ExpressionAttributeValues: { ':active': 'active', ':provisioning': 'provisioning', ':now': now.toISOString(), ':nums': [number], ':engine': engine, ':ob': onboardingId },
        }));
      } catch (err) {
        if (isConditionFailure(err)) throw new ProfileNotActivatableError();
        throw err;
      }
    },

    async flipIdentityRoute({ channel, channelUserId, tenantId, onboardingId, now }) {
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { PK: keys.identityRoutePk(channel, channelUserId), SK: keys.routeSk() },
          UpdateExpression: 'SET #role = :owner, tid = :tid, tenantState = :active, activatedAt = :now REMOVE onboardingId',
          ConditionExpression: 'attribute_exists(PK) AND (onboardingId = :ob OR tid = :tid)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':owner': 'owner', ':active': 'active', ':tid': tenantId, ':ob': onboardingId, ':now': now.toISOString() },
        }));
      } catch (err) {
        if (isConditionFailure(err)) throw new IdentityRouteConflictError();
        throw err;
      }
    },
  };
}

/** Step Functions entry: the whole workflow state (onboardingId, tenantId, number, agent, smoke, owner). */
export async function handler(event: ActivateInput): Promise<ActivateResult> {
  parseActivateInput(event); // refuses before any AWS client exists: a failed smoke call, a bad tenant id, a bad number
  const table = requireEnv('TABLE_NAME');
  const bus = requireEnv('EVENT_BUS_NAME');
  const { doc, eb } = awsClients();
  const publish = eventBridgePublisher(eb, bus);
  return activateTenant(event, {
    store: ddbActivateStore(doc, table),
    publish,
    status: { saveLatest: ddbStatusStore(doc, table), publish },
  });
}
