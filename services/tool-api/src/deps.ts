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

/** Structural twins of T0's KnowledgeQuery/KnowledgeHit/KnowledgeIndex (lib/repo.ts on claude/1145-t0). They are
 *  declared here so this file compiles before and after T0 lands; the shapes are identical. */
export interface KnowledgeQueryLike { tenantId: string; text: string; topK: number; verifiedOnly: boolean; filter: Record<string, unknown> }
export interface KnowledgeHitLike { text: string; source: string; verified: boolean; tenantId: string; score?: number }
export interface KnowledgeIndexLike { query(q: KnowledgeQueryLike): Promise<KnowledgeHitLike[]> }

/** The two SDK calls the adapter needs, injected so the adapter is testable and so the SDK clients
 *  (@aws-sdk/client-s3vectors, @aws-sdk/client-bedrock-runtime; see CHANGE_REQUESTS/T7-2) can be added by P3 later. */
export interface KnowledgePorts {
  vectorBucketName: string;
  indexName: string;
  /** Titan text embedding of the query text. */
  embed(text: string): Promise<number[]>;
  /** S3 Vectors QueryVectors. */
  queryVectors(input: {
    vectorBucketName: string; indexName: string; queryVector: { float32: number[] }; topK: number;
    filter: Record<string, unknown>; returnMetadata: true; returnDistance: true;
  }): Promise<{ vectors?: Array<{ key?: string; distance?: number; metadata?: Record<string, unknown> }> }>;
}

/** S3 Vectors-backed knowledge search. The filter is passed through exactly as the handler built it from the verified
 *  context. Hits are re-checked anyway: wrong tenant or no text is dropped, missing `verified` means unverified. */
export function s3VectorsKnowledge(ports: KnowledgePorts): KnowledgeIndexLike {
  return {
    async query(q) {
      const queryVector = { float32: await ports.embed(q.text) };
      const r = await ports.queryVectors({
        vectorBucketName: ports.vectorBucketName, indexName: ports.indexName, queryVector, topK: q.topK,
        filter: q.filter, returnMetadata: true, returnDistance: true,
      });
      const hits: KnowledgeHitLike[] = [];
      for (const v of r.vectors ?? []) {
        const m = v.metadata ?? {};
        if (typeof m.text !== 'string' || !m.text || m.tenantId !== q.tenantId) continue;
        hits.push({
          text: m.text, source: typeof m.source === 'string' ? m.source : '', verified: m.verified === true,
          tenantId: m.tenantId, ...(v.distance === undefined ? {} : { score: 1 - v.distance }),
        });
      }
      return hits;
    },
  };
}

let memo: (ToolDeps & AuthDeps) | undefined;
/** `knowledge` ports are optional: until the S3 Vectors and Bedrock clients are available to this lane the handlers
 *  fall back to repo.searchVerifiedFacts. */
export async function prodDeps(knowledge?: KnowledgePorts): Promise<ToolDeps & AuthDeps> {
  if (memo) return memo;
  const base: ToolDeps & AuthDeps = {
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
  // Object.assign keeps this compiling both before and after ToolDeps gains the optional `knowledge` field (T0).
  memo = knowledge ? Object.assign(base, { knowledge: s3VectorsKnowledge(knowledge) }) : base;
  return memo;
}
