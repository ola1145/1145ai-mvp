import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@1145/shared';
import type { AuthDeps } from './lib/tenant-auth.js';
import type { KnowledgeHit, KnowledgeIndex, KnowledgeQuery, ToolDeps } from './lib/repo.js';
import { ddbRepoFor } from './lib/ddb-repo.js';

const eb = new EventBridgeClient({});
const sm = new SecretsManagerClient({});
// The Lambda execution role can read ONLY the route items its function needs (see api-stack.ts); tenant data goes through ddbRepoFor.
const routeDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The tool API secret (Secrets Manager JSON). Token keys sign call and chat tokens; step-up keys sign the dashboard's
 *  proof that the owner just re-confirmed a price change. They are different secrets on purpose. */
interface ToolApiSecret {
  tokenCurrent?: string; tokenPrevious?: string; engineSecret?: string; stepUpCurrent?: string; stepUpPrevious?: string;
}

interface Secrets { tokens: string[]; engine?: string; stepUp: string[]; at: number }
let secretsCache: Secrets | undefined;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Pure part of the secret handling, so it can be tested without Secrets Manager. */
export function parseToolApiSecret(raw: string | undefined, env: Record<string, string | undefined> = process.env): Omit<Secrets, 'at'> {
  let s: ToolApiSecret = {};
  try { s = JSON.parse(raw ?? '{}') as ToolApiSecret; } catch { /* unreadable secret: no keys, every signed request fails closed */ }
  const tokens = [s.tokenCurrent, s.tokenPrevious].filter(nonEmpty);
  // STEP_UP_SECRET (env) keeps local runs working; in Lambda the secret JSON is the source.
  const wanted = [s.stepUpCurrent, s.stepUpPrevious, env.STEP_UP_SECRET].filter(nonEmpty);
  // Whoever holds a call-token key can mint call tokens. A step-up key equal to one would let them mint step-ups too.
  const stepUp = wanted.filter((k) => !tokens.includes(k));
  if (stepUp.length !== wanted.length) {
    console.error(JSON.stringify({ level: 'error', msg: 'a step-up secret is the same as a tenant token secret and was ignored; price edits fail closed until it is rotated' }));
  }
  return { tokens, engine: nonEmpty(s.engineSecret) ? s.engineSecret : undefined, stepUp };
}

async function secrets(): Promise<Secrets> {
  if (secretsCache && Date.now() - secretsCache.at < 300_000) return secretsCache;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.TOOL_API_SECRET_ARN }));
  secretsCache = { ...parseToolApiSecret(r.SecretString), at: Date.now() };
  return secretsCache;
}

// ---- knowledge search: S3 Vectors + Bedrock (CR T0-1, T7-2) ---------------------------------------------------------------

/** The two SDK calls the adapter needs, injected so the adapter is testable. `knowledgePortsFromEnv` builds the real ones. */
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
export function s3VectorsKnowledge(ports: KnowledgePorts): KnowledgeIndex {
  return {
    async query(q: KnowledgeQuery): Promise<KnowledgeHit[]> {
      const queryVector = { float32: await ports.embed(q.text) };
      const r = await ports.queryVectors({
        vectorBucketName: ports.vectorBucketName, indexName: ports.indexName, queryVector, topK: q.topK,
        filter: q.filter, returnMetadata: true, returnDistance: true,
      });
      const hits: KnowledgeHit[] = [];
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

/** The slice of each AWS SDK client module the knowledge ports use. */
interface SdkClient { send(command: unknown): Promise<any> } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface AwsSdkModules {
  s3vectors: { S3VectorsClient: new (config: Record<string, unknown>) => SdkClient; QueryVectorsCommand: new (input: Record<string, unknown>) => unknown };
  bedrock: { BedrockRuntimeClient: new (config: Record<string, unknown>) => SdkClient; InvokeModelCommand: new (input: Record<string, unknown>) => unknown };
}
export type SdkLoader = () => Promise<AwsSdkModules>;

/** `@aws-sdk/client-s3vectors` and `@aws-sdk/client-bedrock-runtime` are not declared dependencies of this package yet
 *  (P3 owns them, CR T0-1 item 3), and the bundle leaves `@aws-sdk/*` to the Lambda runtime. Load them by name at first
 *  use, so a runtime without them costs the knowledge index (handlers fall back to keyword search), not the function. */
const importByName = (name: string): Promise<any> => import(/* @vite-ignore */ name); // eslint-disable-line @typescript-eslint/no-explicit-any
const loadAwsSdk: SdkLoader = async () => {
  const [s3vectors, bedrock] = await Promise.all([importByName('@aws-sdk/client-s3vectors'), importByName('@aws-sdk/client-bedrock-runtime')]);
  return { s3vectors, bedrock };
};

/** Titan Text Embeddings V2. The ingest side must embed with the same model (and dimension) the index was created with. */
const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
/** Per call (embedding, then query), so the worst case stays well inside the 3 s voice-route timeout with the keyword fallback. */
const DEFAULT_KNOWLEDGE_TIMEOUT_MS = 1000;

const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};

function withDeadline<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const positiveInt = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * The real ports, from the environment the kb/search function gets from api-stack.ts: KNOWLEDGE_VECTOR_BUCKET and
 * KNOWLEDGE_VECTOR_INDEX (both required, else knowledge search stays on the keyword path), KNOWLEDGE_EMBED_DIMENSIONS
 * (optional, Titan's default is 1024) and KNOWLEDGE_TIMEOUT_MS (default 1000 per call, so a slow index falls back to keyword
 * search instead of holding the caller). Clients are created on first use, once per container.
 */
export function knowledgePortsFromEnv(env: Record<string, string | undefined> = process.env, load: SdkLoader = loadAwsSdk): KnowledgePorts | undefined {
  const vectorBucketName = env.KNOWLEDGE_VECTOR_BUCKET?.trim();
  const indexName = env.KNOWLEDGE_VECTOR_INDEX?.trim();
  if (!vectorBucketName || !indexName) return undefined;
  const dimensions = positiveInt(env.KNOWLEDGE_EMBED_DIMENSIONS);
  const timeoutMs = positiveInt(env.KNOWLEDGE_TIMEOUT_MS) ?? DEFAULT_KNOWLEDGE_TIMEOUT_MS;

  const sdk = once(load); // a failed import is remembered: the package is missing, not flaky
  const vectors = once(async () => { const { S3VectorsClient } = (await sdk()).s3vectors; return new S3VectorsClient({}); });
  const bedrock = once(async () => { const { BedrockRuntimeClient } = (await sdk()).bedrock; return new BedrockRuntimeClient({}); });

  return {
    vectorBucketName,
    indexName,
    embed: (text) => withDeadline(timeoutMs, 'embedding', (async () => {
      const { InvokeModelCommand } = (await sdk()).bedrock;
      const r = await (await bedrock()).send(new InvokeModelCommand({
        modelId: EMBED_MODEL_ID, contentType: 'application/json', accept: 'application/json',
        body: JSON.stringify({ inputText: text, ...(dimensions ? { dimensions } : {}), normalize: true }),
      }));
      const embedding = (JSON.parse(new TextDecoder().decode(r.body)) as { embedding?: unknown }).embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error('embedding response had no usable embedding');
      }
      return embedding as number[];
    })()),
    queryVectors: (input) => withDeadline(timeoutMs, 'vector query', (async () => {
      const { QueryVectorsCommand } = (await sdk()).s3vectors;
      return (await vectors()).send(new QueryVectorsCommand(input));
    })()),
  };
}

// ---- production deps ---------------------------------------------------------------------------------------------------

export type ProdDeps = ToolDeps & AuthDeps & {
  /** Step-up signing secrets (current + previous). Empty means price edits answer 428 (fail closed). */
  stepUpSecrets(): Promise<readonly string[]>;
};

let memo: ProdDeps | undefined;
/** `knowledge` defaults to the S3 Vectors index named in the environment (only the kb/search function has it). Without
 *  one the handlers use repo.searchVerifiedFacts. */
export async function prodDeps(knowledge: KnowledgePorts | undefined = knowledgePortsFromEnv()): Promise<ProdDeps> {
  if (memo) return memo;
  const base: ProdDeps = {
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
    stepUpSecrets: async () => (await secrets()).stepUp,
    tenantForEngineAgent: async (agentId) => {
      try {
        const r = await routeDoc.send(new GetCommand({
          TableName: process.env.TABLE_NAME ?? 't1145',
          Key: { PK: keys.engineAgentRoutePk('elevenlabs', agentId), SK: keys.routeSk() },
        }));
        return r.Item?.tid as string | undefined;
      } catch (err) {
        // Only the functions that serve customer tools may read agent routes (api-stack.ts). A dashboard or admin function
        // that gets an engine request is the wrong door: answer "unknown agent" (403), not a 500.
        if ((err as { name?: string } | null)?.name !== 'AccessDeniedException') throw err;
        console.error(JSON.stringify({ level: 'error', msg: 'this function may not look up ElevenAgents agents' }));
        return undefined;
      }
    },
    ...(knowledge ? { knowledge: s3VectorsKnowledge(knowledge) } : {}),
  };
  memo = base;
  return memo;
}
