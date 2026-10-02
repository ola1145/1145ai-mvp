import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import type { AuthDeps } from './lib/tenant-auth.js';
import type { ToolDeps } from './lib/repo.js';
import { ddbRepoFor } from './lib/ddb-repo.js';

const eb = new EventBridgeClient({});
const sm = new SecretsManagerClient({});
// The Lambda execution role can read ONLY route items (NUMBER#, IDENTITY#, ENGINEAGENT#); tenant data goes through ddbRepoFor.
const routeDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let secretsCache: { tokens: string[]; engine?: string; at: number } | undefined;

async function secrets() {
  if (secretsCache && Date.now() - secretsCache.at < 300_000) return secretsCache;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.TOOL_API_SECRET_ARN }));
  const s = JSON.parse(r.SecretString ?? '{}') as { tokenCurrent?: string; tokenPrevious?: string; engineSecret?: string };
  secretsCache = { tokens: [s.tokenCurrent, s.tokenPrevious].filter((x): x is string => !!x), engine: s.engineSecret, at: Date.now() };
  return secretsCache;
}

let memo: (ToolDeps & AuthDeps) | undefined;
export async function prodDeps(): Promise<ToolDeps & AuthDeps> {
  memo ??= {
    repoFor: ddbRepoFor,
    publish: async (event) => {
      await eb.send(new PutEventsCommand({ Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME ?? '1145', Source: '1145.tool-api', DetailType: event.type, Detail: JSON.stringify(event),
      }] }));
    },
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tokenSecrets: async () => (await secrets()).tokens,
    engineSecret: async () => (await secrets()).engine,
    tenantForEngineAgent: async (agentId) => {
      const r = await routeDoc.send(new GetCommand({
        TableName: process.env.TABLE_NAME ?? 't1145',
        Key: { PK: keys.engineAgentRoutePk('elevenlabs', agentId), SK: keys.routeSk() },
      }));
      return r.Item?.tid as string | undefined;
    },
  };
  return memo;
}
