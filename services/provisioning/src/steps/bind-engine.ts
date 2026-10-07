import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, type EngineId, type TenantId, type TenantRuntimeState } from '@1145/shared';
import { loadTelnyxConfig, telnyxClient, type TelnyxClient } from '../lib/telnyx.js';

/**
 * Step: bind-engine (LiveKit on Telnyx, ADR-0002).
 * For this engine the "agent" is configuration in our table (see engines/livekit-adapter): the frontdesk worker
 * resolves the tenant from the dialed number. So binding is: point the number at the LiveKit SIP connection, write the
 * NUMBER# and ENGINEAGENT# route items the resolver reads, then record the engine reference on the tenant PROFILE so
 * RenderAgent (which needs `{engine, tenantId, agentId}`) and the console (which reads `engine` and `engineRef`) agree
 * on one agent. The agent id matches the adapter's `frontdesk:<tenantId>`. The runtime config itself is written later
 * by RenderAgent.
 */
export interface BindEngineInput {
  onboardingId: string; tenantId: string; number: string; connectionId: string;
  /** What the owner typed at signup, already stored under ONBOARDING#. Only seeds a brand new PROFILE; never overwrites. */
  basics?: { businessName?: string; businessType?: string };
}
export interface BindEngineResult { number: string; engine: EngineId; agentId: string }

export interface RouteStore {
  /** Conditional: creates the route, or rewrites it only when it already belongs to the same tenant. */
  putNumberRoute(number: string, route: { tid: string; engine: EngineId; state: TenantRuntimeState }): Promise<void>;
  putEngineAgentRoute(engine: EngineId, agentId: string, route: { tid: string }): Promise<void>;
}

/** The rest of the LiveKit adapter's RouteStore port (CR E6-1): reads, and the conditional state flip. */
export interface AdapterRouteStore extends RouteStore {
  getNumberRoute(number: string): Promise<{ tid: string; state: TenantRuntimeState; engine: EngineId } | undefined>;
  numbersFor(tenantId: TenantId): Promise<string[]>;
  /** True when the route was flipped; false when it is gone or belongs to another tenant (never a throw for those). */
  setNumberState(number: string, tenantId: TenantId, state: TenantRuntimeState): Promise<boolean>;
  deleteNumberRoute(number: string): Promise<void>;
}

export interface ProfileBinding {
  tenantId: string; onboardingId: string; number: string; engine: EngineId; agentId: string;
  basics?: BindEngineInput['basics'];
}
export interface ProfileBinder { recordBinding(b: ProfileBinding): Promise<void> }

export class RouteConflictError extends Error {
  constructor(what: string) { super(`RouteConflict: ${what} already routes to another tenant`); this.name = 'RouteConflict'; }
}

const ENGINE: EngineId = 'livekit-telnyx';
const E164_RE = /^\+[1-9]\d{6,14}$/;
const STATES: ReadonlySet<string> = new Set<TenantRuntimeState>(['active', 'suspended', 'over_cap']);

export async function bindEngine(
  input: BindEngineInput,
  deps: { telnyx: Pick<TelnyxClient, 'assignToConnection'>; routes: RouteStore; profile?: ProfileBinder },
): Promise<BindEngineResult> {
  const tenantId = asTenantId(input.tenantId); // set server-side by the start endpoint; format-checked here as defense in depth
  if (!E164_RE.test(input.number)) throw new Error('bind-engine: number is not E.164');
  const agentId = `frontdesk:${tenantId}`;

  await deps.telnyx.assignToConnection(input.number, input.connectionId); // idempotent; retried while the order settles
  await deps.routes.putNumberRoute(input.number, { tid: tenantId, engine: ENGINE, state: 'active' });
  await deps.routes.putEngineAgentRoute(ENGINE, agentId, { tid: tenantId });
  // Last, so a retry after a failure here repeats only idempotent steps. A failure fails the step: never move on without it.
  await deps.profile?.recordBinding({ tenantId, onboardingId: input.onboardingId, number: input.number, engine: ENGINE, agentId, basics: input.basics });
  return { number: input.number, engine: ENGINE, agentId };
}

/** Route items (contracts/dynamodb/keys.md). A route is never taken over from another tenant. */
export function ddbRouteStore(client: { send(cmd: any): Promise<any> }, table: string): AdapterRouteStore {
  const SAME_TENANT_ONLY = 'attribute_not_exists(PK) OR tid = :tid';
  const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';
  async function put(pk: string, attrs: Record<string, string>) {
    try {
      await client.send(new PutCommand({
        TableName: table,
        Item: { PK: pk, SK: keys.routeSk(), ...attrs },
        ConditionExpression: SAME_TENANT_ONLY,
        ExpressionAttributeValues: { ':tid': attrs.tid },
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new RouteConflictError(pk.split('#')[0]!);
      throw err;
    }
  }
  return {
    putNumberRoute: (number, r) => put(keys.numberRoutePk(number), { tid: r.tid, engine: r.engine, state: r.state }),
    putEngineAgentRoute: (engine, agentId, r) => put(keys.engineAgentRoutePk(engine, agentId), { tid: r.tid }),

    async getNumberRoute(number) {
      const out = await client.send(new GetCommand({ TableName: table, Key: { PK: keys.numberRoutePk(number), SK: keys.routeSk() }, ConsistentRead: true }));
      const item = out.Item as { tid?: unknown; state?: unknown; engine?: unknown } | undefined;
      if (!item || typeof item.tid !== 'string') return undefined;
      const state = typeof item.state === 'string' && STATES.has(item.state) ? (item.state as TenantRuntimeState) : 'suspended'; // unknown reads as the stricter state
      return { tid: item.tid, state, engine: (typeof item.engine === 'string' ? item.engine : ENGINE) as EngineId };
    },
    async numbersFor(tenantId) {
      const out = await client.send(new GetCommand({ TableName: table, Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() }, ConsistentRead: true }));
      const numbers = (out.Item as { numbers?: unknown } | undefined)?.numbers;
      return Array.isArray(numbers) ? numbers.filter((n): n is string => typeof n === 'string' && E164_RE.test(n)) : [];
    },
    async setNumberState(number, tenantId, state) {
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { PK: keys.numberRoutePk(number), SK: keys.routeSk() },
          UpdateExpression: 'SET #s = :s', ConditionExpression: 'tid = :tid', // only this tenant's own route, and only if it exists
          ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':s': state, ':tid': tenantId },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },
    async deleteNumberRoute(number) {
      await client.send(new DeleteCommand({ TableName: table, Key: { PK: keys.numberRoutePk(number), SK: keys.routeSk() } }));
    },
  };
}

/**
 * PROFILE.engine and PROFILE.engineRef, written by one UpdateItem on the tenant's own PROFILE.
 * `engineRef` is the full reference object `{engine, tenantId, agentId}`: RenderAgent needs all three to address the
 * engine, and the console reads `agentId` from it. Nothing else creates the PROFILE before activation, so this also
 * seeds it (identity fields only when they are new; an existing state, name or number list is never overwritten, so a
 * re-run cannot un-suspend or rename a tenant).
 */
export function ddbProfileBinder(client: { send(cmd: any): Promise<any> }, table: string, now: () => Date = () => new Date()): ProfileBinder {
  return {
    async recordBinding(b) {
      const tenantId = asTenantId(b.tenantId);
      const names: Record<string, string> = { '#engine': 'engine', '#state': 'state', '#numbers': 'numbers' };
      const values: Record<string, unknown> = {
        ':engine': b.engine,
        ':ref': { engine: b.engine, tenantId, agentId: b.agentId },
        ':provisioning': 'provisioning',
        ':nums': [b.number],
        ':onb': b.onboardingId,
        ':now': now().toISOString(),
      };
      const sets = [
        '#engine = :engine', 'engineRef = :ref',
        '#state = if_not_exists(#state, :provisioning)', '#numbers = if_not_exists(#numbers, :nums)',
        'onboardingId = if_not_exists(onboardingId, :onb)', 'createdAt = if_not_exists(createdAt, :now)',
      ];
      const name = b.basics?.businessName?.trim();
      if (name) {
        names['#name'] = 'name'; values[':name'] = name;
        sets.push('#name = if_not_exists(#name, :name)', 'businessName = if_not_exists(businessName, :name)');
      }
      const type = b.basics?.businessType?.trim();
      if (type) {
        names['#type'] = 'type'; values[':type'] = type;
        sets.push('#type = if_not_exists(#type, :type)', 'businessType = if_not_exists(businessType, :type)');
      }
      await client.send(new UpdateCommand({
        TableName: table, Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
        UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
    },
  };
}

/** Step Functions entry: onboardingId, tenantId and number.order.number come from workflow state. */
export async function handler(event: { onboardingId?: string; tenantId?: string; number?: { order?: { number?: string } }; basics?: { businessName?: unknown; businessType?: unknown } }) {
  const { onboardingId, tenantId } = event;
  const number = event.number?.order?.number;
  if (!onboardingId || !tenantId || !number) throw new Error('bind-engine needs onboardingId, tenantId and the ordered number');
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const cfg = await loadTelnyxConfig();
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const clip = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
  const basics = { businessName: clip(event.basics?.businessName), businessType: clip(event.basics?.businessType) };
  return bindEngine(
    { onboardingId, tenantId, number, connectionId: cfg.connectionId, basics },
    { telnyx: telnyxClient(cfg.apiKey), routes: ddbRouteStore(doc, table), profile: ddbProfileBinder(doc, table) },
  );
}
