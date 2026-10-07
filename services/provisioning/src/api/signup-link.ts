/**
 * Telegram onboarding: mint signup token and send the link in-channel.
 * Owner: issue D4 (tasks/D4.md). Contract: contracts/openapi/onboarding-internal.yaml
 * (POST /internal/onboarding/{onboardingId}/signup-link).
 *
 * The agent calls this as a tool and must never see the link. So:
 *  - the token is minted here, only its hash is stored, and the response says nothing but "sent";
 *  - the link goes through the Telegram sender to the chat identity the ROUTER stored on the onboarding record, never
 *    to anything in the request body;
 *  - the onboarding id comes from the path the router bound, behind the service token.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { safeEqual } from '@1145/shared';
import {
  SIGNUP_TTL_SECONDS,
  buildSignupUrl,
  createSignupStores,
  newPkcePair,
  newSignupToken,
  signupLinkMessage,
  type CognitoLinkConfig,
  type DocClient,
  type SignupStore,
} from '../lib/signup-token.js';

export interface OnboardingIdentity { channel: string; channelUserId: string }

export interface SignupLinkDeps {
  /** Checks the service token. Fail closed. The onboarding id is passed so a token bound to one onboarding can be enforced. */
  authorize(authorization: string | undefined, onboardingId: string): Promise<boolean>;
  /** The channel identity the router stored when the onboarding started. */
  onboardings: { get(onboardingId: string): Promise<OnboardingIdentity | undefined> };
  signups: Pick<SignupStore, 'issue'>;
  link: CognitoLinkConfig;
  sendTelegram(chatId: string, text: string): Promise<void>;
  now?: () => Date;
}

interface ApiEvent {
  rawPath?: string;
  path?: string;
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string | null;
}

interface ApiResult { statusCode: number; headers: Record<string, string>; body: string }

const json = (statusCode: number, body: unknown): ApiResult => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
/** Errors read as { code, message }: agents/common/api.py turns that into the tool's error. */
const fail = (statusCode: number, code: string, message: string) => json(statusCode, { code, message });

const ONBOARDING_ID = /^[A-Za-z0-9_-]{1,64}$/;

function header(headers: ApiEvent['headers'], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** The route is /internal/onboarding/{id}/signup-link (the stack names the parameter `id`, the contract `onboardingId`). */
function onboardingIdOf(ev: ApiEvent): string | undefined {
  const fromParams = ev.pathParameters?.onboardingId ?? ev.pathParameters?.id;
  if (fromParams) return fromParams;
  return /^\/internal\/onboarding\/([^/]+)\/signup-link\/?$/.exec(ev.rawPath ?? ev.path ?? '')?.[1];
}

/** Static service token today (ONBOARDING_SERVICE_TOKEN in the runtime secret). Compared in constant time. */
export function serviceTokenAuthorizer(getToken: () => Promise<string | undefined>): SignupLinkDeps['authorize'] {
  return async (authorization) => {
    const presented = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
    if (!presented) return false;
    const expected = await getToken();
    if (!expected) return false;
    return safeEqual(presented, expected);
  };
}

export function createOnboardingReader(cfg: { doc: DocClient; tableName: string }): SignupLinkDeps['onboardings'] {
  return {
    async get(onboardingId) {
      if (!ONBOARDING_ID.test(onboardingId)) throw new Error('invalid key segment: onboardingId');
      const r = (await cfg.doc.send(new GetCommand({
        TableName: cfg.tableName, ConsistentRead: true,
        Key: { PK: `ONBOARDING#${onboardingId}`, SK: 'STATE' },
      }))) as { Item?: Record<string, unknown> };
      const i = r.Item;
      if (!i || typeof i.channel !== 'string' || typeof i.channelUserId !== 'string') return undefined;
      return { channel: i.channel, channelUserId: i.channelUserId };
    },
  };
}

export interface TelegramPosterConfig {
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * Telegram sendMessage with link previews OFF (a preview fetch would otherwise touch the signup link before the
 * owner does, and cache it). Retries 429 (honoring retry_after) and 5xx; never retries other 4xx.
 * Swap for the shared sender once telegram-send.ts (C2) exports one: contracts/CHANGE_REQUESTS/D4-2.md.
 */
export function createTelegramPoster(cfg: TelegramPosterConfig): SignupLinkDeps['sendTelegram'] {
  const doFetch = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = cfg.maxAttempts ?? 3;
  return async function sendTelegram(chatId, text) {
    const token = await cfg.token();
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      });
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      // The message never includes the URL: it holds the bot token.
      if (!retryable || attempt >= attempts) throw new Error(`telegram sendMessage failed: ${res.status}`);
      let waitMs = 500 * 2 ** (attempt - 1);
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
        if (typeof body.parameters?.retry_after === 'number') waitMs = Math.min(body.parameters.retry_after, 30) * 1000;
      }
      await sleep(waitMs);
    }
  };
}

export function makeHandler(deps: SignupLinkDeps) {
  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    const onboardingId = onboardingIdOf(ev);

    if (!(await deps.authorize(header(ev.headers, 'authorization'), onboardingId ?? ''))) {
      return fail(401, 'unauthorized', 'Missing or wrong service token.');
    }
    if (!onboardingId || !ONBOARDING_ID.test(onboardingId)) return fail(400, 'invalid_onboarding_id', 'That is not a valid onboarding id.');
    // The request body is deliberately never read: nothing in it may choose the onboarding, the chat or the channel.

    const onboarding = await deps.onboardings.get(onboardingId);
    if (!onboarding) return fail(404, 'unknown_onboarding', 'No onboarding with that id.');
    if (onboarding.channel !== 'telegram') {
      return fail(409, 'link_not_needed', 'This owner is not on Telegram. Web chat owners are already signed in with Google.');
    }

    const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const { token, hash } = newSignupToken();
    const pkce = newPkcePair();
    let message: string;
    try {
      message = signupLinkMessage(buildSignupUrl(deps.link, token, pkce.challenge));
    } catch {
      return fail(500, 'misconfigured', 'The sign-in link is not set up on our side.');
    }

    const issued = await deps.signups.issue(hash, {
      onboardingId, channel: 'telegram', channelUserId: onboarding.channelUserId,
      exp: nowSeconds + SIGNUP_TTL_SECONDS, codeVerifier: pkce.verifier,
    }, nowSeconds);
    if (issued === 'already_confirmed') return fail(409, 'already_confirmed', 'Their Google sign-in is already confirmed.');

    try {
      await deps.sendTelegram(onboarding.channelUserId, message);
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', message: 'signup link not delivered', err: err instanceof Error ? err.message : 'unknown' }));
      return fail(502, 'delivery_failed', "Telegram didn't take the message.");
    }
    return json(200, { sent: true, expiresInMinutes: SIGNUP_TTL_SECONDS / 60 });
  };
}

// ───────────────────────── production wiring (lazy: importing this module needs no environment) ─────────────────────────

/** Keys of the runtime secret `1145/<stage>/runtime` (scripts/secrets/push.sh) that these handlers read. */
interface RuntimeSecret { TELEGRAM_BOT_TOKEN?: string; ONBOARDING_SERVICE_TOKEN?: string }

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const tableName = requiredEnv(env, 'TABLE_NAME');
  const secretId = requiredEnv(env, 'RUNTIME_SECRET_ID');
  const sm = new SecretsManagerClient({});
  let cache: { value: RuntimeSecret; at: number } | undefined;
  const runtimeSecret = async (): Promise<RuntimeSecret> => {
    if (cache && Date.now() - cache.at < 300_000) return cache.value;
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    cache = { value: JSON.parse(r.SecretString ?? '{}') as RuntimeSecret, at: Date.now() };
    return cache.value;
  };
  const sendTelegram = createTelegramPoster({
    token: async () => {
      const t = (await runtimeSecret()).TELEGRAM_BOT_TOKEN;
      if (!t) throw new Error('TELEGRAM_BOT_TOKEN missing from runtime secret');
      return t;
    },
  });
  return { doc, tableName, runtimeSecret, sendTelegram };
}

function buildProd() {
  const rt = createRuntime();
  const { signups } = createSignupStores({ doc: rt.doc, tableName: rt.tableName });
  return makeHandler({
    authorize: serviceTokenAuthorizer(async () => (await rt.runtimeSecret()).ONBOARDING_SERVICE_TOKEN),
    onboardings: createOnboardingReader({ doc: rt.doc, tableName: rt.tableName }),
    signups,
    link: {
      domain: requiredEnv(process.env, 'COGNITO_DOMAIN'),
      clientId: requiredEnv(process.env, 'COGNITO_CLIENT_ID'),
      redirectUri: requiredEnv(process.env, 'SIGNUP_REDIRECT_URI'),
    },
    sendTelegram: rt.sendTelegram,
  });
}

let prod: ReturnType<typeof makeHandler> | undefined;
export async function handler(event: unknown): Promise<ApiResult> {
  try {
    prod ??= buildProd();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'signup-link is not configured', err: err instanceof Error ? err.message : 'unknown' }));
    return fail(500, 'misconfigured', 'The sign-in link is not set up on our side.');
  }
  return prod(event);
}
