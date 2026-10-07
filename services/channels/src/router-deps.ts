/**
 * Production RouterDeps: identity routes, startOnboarding, AgentCore invoke, per-channel senders, applyChange.
 * Owner: issue C1 (tasks/C1.md). Pure wiring: the logic lives in ./router.ts and ./lib/*, all unit-tested with fakes.
 */
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { RouterDeps } from './router.js';
import { createAgentInvoker, type AgentRuntimeClient } from './lib/agentcore.js';
import { createOwnerChatPublisher } from './lib/appsync-events.js';
import { createBindingAnswerer } from './lib/binding.js';
import { APPLIED_LINE, CODE_NOT_FOUND_LINE, SNAG_LINES, STEP_UP_LINE } from './lib/copy.js';
import { createSender } from './lib/senders.js';
import { createStore } from './lib/store.js';
import { createTelegramSender } from './telegram-send.js';

/** Keys in the runtime secret `1145/<stage>/runtime` (scripts/secrets/push.sh). */
interface RuntimeSecret { TOOL_API_TOKEN_SECRET_CURRENT?: string; TELEGRAM_BOT_TOKEN?: string }

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/**
 * What is deployed: every dependency, including the deterministic YES / NO for the pending identity binding (SEC-20) and the
 * per-identity message cap (SEC-25). Both are optional on `RouterDeps` so test fakes can leave them out; here they are not.
 */
export type ProdRouterDeps = RouterDeps & Required<Pick<RouterDeps, 'answerPendingBinding' | 'checkRate'>>;

export function createProdDeps(env: NodeJS.ProcessEnv = process.env): ProdRouterDeps {
  const region = env.AWS_REGION ?? 'us-east-1';
  const sm = new SecretsManagerClient({});
  let secretCache: { value: RuntimeSecret; at: number } | undefined;
  const runtimeSecret = async (): Promise<RuntimeSecret> => {
    if (secretCache && Date.now() - secretCache.at < 300_000) return secretCache.value;
    const r = await sm.send(new GetSecretValueCommand({ SecretId: required(env, 'RUNTIME_SECRET_ID') }));
    secretCache = { value: JSON.parse(r.SecretString ?? '{}') as RuntimeSecret, at: Date.now() };
    return secretCache.value;
  };

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const tableName = required(env, 'TABLE_NAME');
  const store = createStore({ doc, tableName });

  const invokeAgent = createAgentInvoker({
    client: new BedrockAgentCoreClient({}) as unknown as AgentRuntimeClient,
    arns: { onboarding: required(env, 'AGENT_ONBOARDING_ARN'), admin: required(env, 'AGENT_ADMIN_ARN') },
  });

  const send = createSender({
    publishOwnerChat: (sub, text, meta) => createOwnerChatPublisher({
      httpDomain: required(env, 'EVENTS_HTTP_DOMAIN'), region, credentials: defaultProvider(),
    })(sub, text, meta),
    sendTelegram: createTelegramSender({
      token: async () => {
        const t = (await runtimeSecret()).TELEGRAM_BOT_TOKEN;
        if (!t) throw new Error('TELEGRAM_BOT_TOKEN missing from runtime secret');
        return t;
      },
    }),
  });

  return {
    ...store,
    // SEC-20: the owner's YES / NO to the identity check never reaches the model.
    answerPendingBinding: createBindingAnswerer({ doc, tableName }),
    invokeAgent,
    send,
    signingSecret: async () => {
      const s = (await runtimeSecret()).TOOL_API_TOKEN_SECRET_CURRENT;
      if (!s) throw new Error('TOOL_API_TOKEN_SECRET_CURRENT missing from runtime secret');
      return s;
    },
    /** Deterministic: POST the code with an owner token. The model never sees this call. */
    async applyChange(code, ownerToken) {
      const res = await fetch(`${required(env, 'TOOL_API_URL').replace(/\/$/, '')}/v1/admin/changes/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: unknown; summary?: unknown };
        const said = typeof body.message === 'string' ? body.message : undefined;
        return { ok: true, message: said ?? APPLIED_LINE };
      }
      if (res.status === 404) return { ok: false, message: CODE_NOT_FOUND_LINE };
      if (res.status === 428) return { ok: false, message: STEP_UP_LINE };
      console.error(JSON.stringify({ level: 'error', message: 'applyChange failed', status: res.status }));
      return { ok: false, message: SNAG_LINES[0] };
    },
  };
}
