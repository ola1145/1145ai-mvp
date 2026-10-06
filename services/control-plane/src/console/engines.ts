import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys, type EngineAgentRef, type TenantRuntimeState, type VoiceEngine } from '@1145/shared';
import type { ConsoleStore } from './types.js';

/**
 * The console only ever needs `setTenantState` from an engine (ADR-0001). For the default LiveKit engine that
 * means flipping `state` on the tenant's NUMBER# routes, which the resolver reads on every call. Each update is
 * conditional on the route still belonging to this tenant.
 *
 * The ElevenLabs engine needs its API key and SIP settings, which belong to the provisioning lane. Until that is
 * wired in, asking for it fails loudly and no state is written.
 */
export function consoleEngineFor(deps: { ddb: DynamoDBDocumentClient; table: string; store: ConsoleStore }) {
  return (ref: EngineAgentRef): VoiceEngine => {
    if (ref.engine !== 'livekit-telnyx') {
      throw new Error(`engine ${ref.engine} is not wired into the console yet`);
    }
    const unsupported = (): never => { throw new Error('not available from the console'); };
    const engine: VoiceEngine = {
      id: 'livekit-telnyx',
      async setTenantState(r: EngineAgentRef, state: TenantRuntimeState) {
        const profile = await deps.store.getProfile(r.tenantId);
        const numbers = Array.isArray(profile?.numbers) ? profile.numbers.filter((n): n is string => typeof n === 'string') : [];
        for (const n of numbers) {
          // A number that now belongs to someone else is not ours to change: skip it.
          await deps.ddb.send(new UpdateCommand({
            TableName: deps.table,
            Key: { PK: keys.numberRoutePk(n), SK: keys.routeSk() },
            UpdateExpression: 'SET #s = :s',
            ConditionExpression: 'tid = :tid',
            ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':s': state, ':tid': r.tenantId },
          })).catch((e: { name?: string }) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
        }
      },
      provisionTenantAgent: unsupported,
      updateTenantAgent: unsupported,
      syncKnowledge: unsupported,
      bindNumber: unsupported,
      unbindNumber: unsupported,
      placeSmokeTestCall: unsupported,
      normalizeCallEvent: unsupported,
    };
    return engine;
  };
}
