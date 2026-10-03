import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, type EngineId, type TenantRuntimeState } from '@1145/shared';
import { loadTelnyxConfig, telnyxClient, type TelnyxClient } from '../lib/telnyx.js';

/**
 * Step: bind-engine (LiveKit on Telnyx, ADR-0002).
 * For this engine the "agent" is configuration in our table (see engines/livekit-adapter): the frontdesk worker
 * resolves the tenant from the dialed number. So binding is: point the number at the LiveKit SIP connection, then
 * write the NUMBER# and ENGINEAGENT# route items the resolver reads. The agent id matches the adapter's
 * `frontdesk:<tenantId>`. The runtime config itself is written later by RenderAgent.
 */
export interface BindEngineInput { onboardingId: string; tenantId: string; number: string; connectionId: string }
export interface BindEngineResult { number: string; engine: EngineId; agentId: string }

export interface RouteStore {
  /** Conditional: creates the route, or rewrites it only when it already belongs to the same tenant. */
  putNumberRoute(number: string, route: { tid: string; engine: EngineId; state: TenantRuntimeState }): Promise<void>;
  putEngineAgentRoute(engine: EngineId, agentId: string, route: { tid: string }): Promise<void>;
}

export class RouteConflictError extends Error {
  constructor(what: string) { super(`RouteConflict: ${what} already routes to another tenant`); this.name = 'RouteConflict'; }
}

const ENGINE: EngineId = 'livekit-telnyx';
const E164_RE = /^\+[1-9]\d{6,14}$/;

export async function bindEngine(input: BindEngineInput, deps: { telnyx: Pick<TelnyxClient, 'assignToConnection'>; routes: RouteStore }): Promise<BindEngineResult> {
  const tenantId = asTenantId(input.tenantId); // set server-side by the start endpoint; format-checked here as defense in depth
  if (!E164_RE.test(input.number)) throw new Error('bind-engine: number is not E.164');
  const agentId = `frontdesk:${tenantId}`;

  await deps.telnyx.assignToConnection(input.number, input.connectionId); // idempotent; retried while the order settles
  await deps.routes.putNumberRoute(input.number, { tid: tenantId, engine: ENGINE, state: 'active' });
  await deps.routes.putEngineAgentRoute(ENGINE, agentId, { tid: tenantId });
  return { number: input.number, engine: ENGINE, agentId };
}

/** Route items (contracts/dynamodb/keys.md). A route is never taken over from another tenant. */
export function ddbRouteStore(client: { send(cmd: any): Promise<any> }, table: string): RouteStore {
  const SAME_TENANT_ONLY = 'attribute_not_exists(PK) OR tid = :tid';
  async function put(pk: string, attrs: Record<string, string>) {
    try {
      await client.send(new PutCommand({
        TableName: table,
        Item: { PK: pk, SK: keys.routeSk(), ...attrs },
        ConditionExpression: SAME_TENANT_ONLY,
        ExpressionAttributeValues: { ':tid': attrs.tid },
      }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new RouteConflictError(pk.split('#')[0]!);
      throw err;
    }
  }
  return {
    putNumberRoute: (number, r) => put(keys.numberRoutePk(number), { tid: r.tid, engine: r.engine, state: r.state }),
    putEngineAgentRoute: (engine, agentId, r) => put(keys.engineAgentRoutePk(engine, agentId), { tid: r.tid }),
  };
}

/** Step Functions entry: onboardingId, tenantId and number.order.number come from workflow state. */
export async function handler(event: { onboardingId?: string; tenantId?: string; number?: { order?: { number?: string } } }) {
  const { onboardingId, tenantId } = event;
  const number = event.number?.order?.number;
  if (!onboardingId || !tenantId || !number) throw new Error('bind-engine needs onboardingId, tenantId and the ordered number');
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const cfg = await loadTelnyxConfig();
  return bindEngine(
    { onboardingId, tenantId, number, connectionId: cfg.connectionId },
    { telnyx: telnyxClient(cfg.apiKey), routes: ddbRouteStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), table) },
  );
}
