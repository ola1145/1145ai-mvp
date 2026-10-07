import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What prodDeps() hands the handlers once everything is wired: step-up secrets (CR T2-1, T4-1), the ElevenAgents agent
 * lookup (SEC-11) and the S3 Vectors + Bedrock knowledge index (CR T0-1, T7-2). AWS clients are replaced, so nothing
 * here reaches the network.
 */

const aws = vi.hoisted(() => ({
  secret: '' as string,
  secretReads: 0,
  dynamoSend: undefined as undefined | ((cmd: { input: Record<string, unknown> }) => Promise<unknown>),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
  SecretsManagerClient: class { async send() { aws.secretReads++; return { SecretString: aws.secret }; } },
}));
vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return { ...real, DynamoDBDocumentClient: class { static from() { return { send: (cmd: { input: Record<string, unknown> }) => aws.dynamoSend!(cmd) }; } } };
});

const SECRET = { tokenCurrent: 'tok-new', tokenPrevious: 'tok-old', engineSecret: 'engine', stepUpCurrent: 'step-new', stepUpPrevious: 'step-old' };

async function load() {
  vi.resetModules();
  return import('../src/deps.js');
}

beforeEach(() => {
  aws.secret = JSON.stringify(SECRET);
  aws.secretReads = 0;
  aws.dynamoSend = async () => ({});
  delete process.env.STEP_UP_SECRET;
  delete process.env.KNOWLEDGE_VECTOR_BUCKET;
  delete process.env.KNOWLEDGE_VECTOR_INDEX;
});

describe('step-up secrets in prodDeps (CR T2-1 item 4, T4-1 item 4)', () => {
  it('reads current and previous from the tool API secret, apart from the tenant token keys', async () => {
    const { prodDeps } = await load();
    const deps = await prodDeps();
    expect(await deps.stepUpSecrets()).toEqual(['step-new', 'step-old']);
    expect(await deps.tokenSecrets()).toEqual(['tok-new', 'tok-old']);
    expect(aws.secretReads).toBe(1); // one Secrets Manager read serves both
  });

  it('has no step-up secret when none is configured, so price edits fail closed (428)', async () => {
    aws.secret = JSON.stringify({ tokenCurrent: 'tok-new' });
    const { prodDeps } = await load();
    expect(await (await prodDeps()).stepUpSecrets()).toEqual([]);
  });

  it('accepts STEP_UP_SECRET from the environment for local runs', async () => {
    aws.secret = JSON.stringify({ tokenCurrent: 'tok-new' });
    process.env.STEP_UP_SECRET = 'from-env';
    const { prodDeps } = await load();
    expect(await (await prodDeps()).stepUpSecrets()).toEqual(['from-env']);
  });

  it('never accepts a step-up secret that is also a tenant token key: whoever can mint call tokens could mint step-ups', async () => {
    aws.secret = JSON.stringify({ ...SECRET, stepUpCurrent: 'tok-new', stepUpPrevious: 'step-old' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prodDeps } = await load();
    expect(await (await prodDeps()).stepUpSecrets()).toEqual(['step-old']);
    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain('tok-new');
    err.mockRestore();
  });
});

describe('ElevenAgents agent lookup', () => {
  it('maps the agent id to a tenant through the ENGINEAGENT# route item', async () => {
    const seen: Array<Record<string, unknown>> = [];
    aws.dynamoSend = async (cmd) => { seen.push(cmd.input); return { Item: { tid: 't_tenanta01' } }; };
    const { prodDeps } = await load();
    expect(await (await prodDeps()).tenantForEngineAgent('agent_A')).toBe('t_tenanta01');
    expect(seen[0]).toMatchObject({ Key: { PK: 'ENGINEAGENT#elevenlabs#agent_A', SK: 'ROUTE' } });
  });

  it('treats a function that may not read routes as an unknown agent (403), not a crash (500)', async () => {
    aws.dynamoSend = async () => { throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prodDeps } = await load();
    expect(await (await prodDeps()).tenantForEngineAgent('agent_A')).toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('still fails loudly on any other error', async () => {
    aws.dynamoSend = async () => { throw new Error('throttled'); };
    const { prodDeps } = await load();
    await expect((await prodDeps()).tenantForEngineAgent('agent_A')).rejects.toThrow('throttled');
  });
});

// ---- knowledge index wiring -----------------------------------------------------------------------------------------

interface Sent { client: string; command: string; input: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

function fakeSdk(opts: { embedding?: unknown; vectors?: unknown[]; hang?: 'embed' | 'query' } = {}) {
  const sent: Sent[] = [];
  const clients: Array<{ name: string; config: unknown }> = [];
  const never = () => new Promise<never>(() => {});
  const sdk = {
    s3vectors: {
      S3VectorsClient: class {
        constructor(config: unknown) { clients.push({ name: 'S3VectorsClient', config }); }
        async send(command: { input: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
          sent.push({ client: 'S3VectorsClient', command: 'QueryVectors', input: command.input });
          if (opts.hang === 'query') return never();
          return { vectors: opts.vectors ?? [] };
        }
      },
      QueryVectorsCommand: class { constructor(public input: Record<string, unknown>) {} },
    },
    bedrock: {
      BedrockRuntimeClient: class {
        constructor(config: unknown) { clients.push({ name: 'BedrockRuntimeClient', config }); }
        async send(command: { input: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
          sent.push({ client: 'BedrockRuntimeClient', command: 'InvokeModel', input: command.input });
          if (opts.hang === 'embed') return never();
          return { body: new TextEncoder().encode(JSON.stringify({ embedding: 'embedding' in opts ? opts.embedding : [0.25, 0.5], inputTextTokenCount: 2 })) };
        }
      },
      InvokeModelCommand: class { constructor(public input: Record<string, unknown>) {} },
    },
  };
  return { sdk, sent, clients, load: async () => sdk };
}

const env = { KNOWLEDGE_VECTOR_BUCKET: 'kb-bucket', KNOWLEDGE_VECTOR_INDEX: 'kb-index' };
const filter = { $and: [{ tenantId: { $eq: 't_a1' } }, { verified: { $eq: true } }] };
const query = { tenantId: 't_a1', text: 'opening hours', topK: 4, verifiedOnly: true, filter };

describe('knowledge ports from the environment (CR T0-1 item 2, T7-2 item 2)', () => {
  it('stays off (keyword search) unless both the bucket and the index are named', async () => {
    const { knowledgePortsFromEnv } = await load();
    const sdk = fakeSdk();
    expect(knowledgePortsFromEnv({}, sdk.load)).toBeUndefined();
    expect(knowledgePortsFromEnv({ KNOWLEDGE_VECTOR_BUCKET: 'kb-bucket' }, sdk.load)).toBeUndefined();
    expect(knowledgePortsFromEnv({ KNOWLEDGE_VECTOR_INDEX: 'kb-index', KNOWLEDGE_VECTOR_BUCKET: '  ' }, sdk.load)).toBeUndefined();
  });

  it('embeds with Titan text embeddings v2 and queries S3 Vectors with the caller-built filter untouched', async () => {
    const { knowledgePortsFromEnv, s3VectorsKnowledge } = await load();
    const sdk = fakeSdk({ vectors: [{ key: 'v1', distance: 0.1, metadata: { text: 'Open 9 to 5', source: 'owner', verified: true, tenantId: 't_a1' } }] });
    const index = s3VectorsKnowledge(knowledgePortsFromEnv(env, sdk.load)!);
    const hits = await index.query(query);
    expect(hits).toEqual([{ text: 'Open 9 to 5', source: 'owner', verified: true, tenantId: 't_a1', score: 0.9 }]);
    expect(sdk.sent).toEqual([
      {
        client: 'BedrockRuntimeClient', command: 'InvokeModel',
        input: { modelId: 'amazon.titan-embed-text-v2:0', contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ inputText: 'opening hours', normalize: true }) },
      },
      {
        client: 'S3VectorsClient', command: 'QueryVectors',
        input: { vectorBucketName: 'kb-bucket', indexName: 'kb-index', queryVector: { float32: [0.25, 0.5] }, topK: 4, filter, returnMetadata: true, returnDistance: true },
      },
    ]);
  });

  it('asks Titan for the index dimension when one is configured, and ignores a nonsense value', async () => {
    const { knowledgePortsFromEnv } = await load();
    const sdk = fakeSdk();
    await knowledgePortsFromEnv({ ...env, KNOWLEDGE_EMBED_DIMENSIONS: '512' }, sdk.load)!.embed('x');
    await knowledgePortsFromEnv({ ...env, KNOWLEDGE_EMBED_DIMENSIONS: 'wide' }, sdk.load)!.embed('x');
    expect(sdk.sent.map((s) => JSON.parse(s.input.body as string))).toEqual([
      { inputText: 'x', dimensions: 512, normalize: true },
      { inputText: 'x', normalize: true },
    ]);
  });

  it('creates each SDK client once, on first use, not at import', async () => {
    const { knowledgePortsFromEnv } = await load();
    const sdk = fakeSdk();
    const ports = knowledgePortsFromEnv(env, sdk.load)!;
    expect(sdk.clients).toEqual([]);
    await ports.embed('a'); await ports.embed('b');
    await ports.queryVectors({ vectorBucketName: 'kb-bucket', indexName: 'kb-index', queryVector: { float32: [1] }, topK: 1, filter, returnMetadata: true, returnDistance: true });
    expect(sdk.clients.map((c) => c.name).sort()).toEqual(['BedrockRuntimeClient', 'S3VectorsClient']);
  });

  it.each([[[]], [[1, 'x']], [[Number.NaN]], ['nope'], [undefined]])('refuses an embedding that is not a list of numbers (%j)', async (embedding) => {
    const { knowledgePortsFromEnv } = await load();
    await expect(knowledgePortsFromEnv(env, fakeSdk({ embedding }).load)!.embed('x')).rejects.toThrow(/embedding/);
  });

  it('only ever queries the bucket and index it was configured with, whatever the caller passes', async () => {
    const { knowledgePortsFromEnv } = await load();
    const sdk = fakeSdk();
    const ports = knowledgePortsFromEnv(env, sdk.load)!;
    expect(ports.vectorBucketName).toBe('kb-bucket');
    expect(ports.indexName).toBe('kb-index');
  });

  it('gives up on a slow embedding or vector query so the handler can fall back to keyword search', async () => {
    const { knowledgePortsFromEnv, s3VectorsKnowledge } = await load();
    for (const hang of ['embed', 'query'] as const) {
      const index = s3VectorsKnowledge(knowledgePortsFromEnv({ ...env, KNOWLEDGE_TIMEOUT_MS: '25' }, fakeSdk({ hang }).load)!);
      await expect(index.query(query)).rejects.toThrow(/timed out/);
    }
  });

  it('reports a missing SDK as an error the handler already survives, and does not retry the import every call', async () => {
    const { knowledgePortsFromEnv } = await load();
    let tries = 0;
    const ports = knowledgePortsFromEnv(env, async () => { tries++; throw new Error('Cannot find package'); })!;
    await expect(ports.embed('x')).rejects.toThrow('Cannot find package');
    await expect(ports.embed('y')).rejects.toThrow('Cannot find package');
    expect(tries).toBe(1);
  });
});

describe('prodDeps knowledge wiring', () => {
  it('leaves deps.knowledge unset when the index is not configured', async () => {
    const { prodDeps } = await load();
    expect((await prodDeps()).knowledge).toBeUndefined();
  });

  it('sets deps.knowledge from the environment the stack gives the kb/search function', async () => {
    Object.assign(process.env, env);
    const { prodDeps } = await load();
    expect((await prodDeps()).knowledge).toBeDefined();
  });
});
