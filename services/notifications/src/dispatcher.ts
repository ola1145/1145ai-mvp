/**
 * EventBridge -> owner notifications by preference: Telegram, email (Resend), web push (VAPID), urgent phone call.
 * Owner: issue C6 (tasks/C6.md). The logic lives in dispatch.ts; this file only wires real clients from the
 * environment and a Secrets Manager secret (NOTIFY_SECRET_ID, JSON with the keys listed in NotifySecret).
 * Nothing here sends anything unless the Lambda is invoked by the bus.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCallPlacer } from './adapters/telnyx-call.js';
import { createPushSender } from './adapters/webpush.js';
import { createResendSender } from './adapters/resend.js';
import { createTelegramSender } from './adapters/telegram.js';
import { dispatch, type DispatchDeps, type DispatchReport } from './dispatch.js';
import { createDynamoStore } from './store.js';
import type { Outcome } from './types.js';

/** Names of the JSON fields in the secret. Values are provisioned by ops, never committed. */
export interface NotifySecret {
  telegramBotToken?: string;
  resendApiKey?: string;
  /** e.g. "Front desk <hello@mail.example>"; the sending domain is verified in Resend by the owner of the account. */
  emailFrom?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  /** mailto: or https: contact for push services. */
  vapidSubject?: string;
  telnyxApiKey?: string;
  telnyxTexmlAppId?: string;
  /** A number we own, in E.164, used as caller ID for the urgent call. */
  urgentCallFrom?: string;
}

const skipped = (what: string) => async (): Promise<Outcome> => ({ status: 'skipped', attempts: 0, detail: `${what} not configured` });

export function buildDeps(secret: NotifySecret, table: string, now: () => Date = () => new Date()): DispatchDeps {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    store: createDynamoStore({ db, table, now }),
    now,
    telegram: secret.telegramBotToken ? createTelegramSender({ token: secret.telegramBotToken }) : skipped('telegram'),
    email: secret.resendApiKey && secret.emailFrom ? createResendSender({ apiKey: secret.resendApiKey, from: secret.emailFrom }) : skipped('email'),
    push: secret.vapidPublicKey && secret.vapidPrivateKey
      ? createPushSender({ publicKey: secret.vapidPublicKey, privateKey: secret.vapidPrivateKey, subject: secret.vapidSubject ?? 'mailto:hello@1145.ai' })
      : skipped('web push'),
    call: secret.telnyxApiKey && secret.telnyxTexmlAppId && secret.urgentCallFrom
      ? createCallPlacer({ apiKey: secret.telnyxApiKey, applicationId: secret.telnyxTexmlAppId, from: secret.urgentCallFrom })
      : skipped('urgent call'),
    log: (line) => console.log(JSON.stringify(line)),
  };
}

let cached: DispatchDeps | undefined;
async function deps(): Promise<DispatchDeps> {
  if (cached) return cached;
  const table = process.env.TABLE_NAME;
  const secretId = process.env.NOTIFY_SECRET_ID;
  if (!table) throw new Error('TABLE_NAME is not set');
  let secret: NotifySecret = {};
  if (secretId) {
    const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
    secret = res.SecretString ? (JSON.parse(res.SecretString) as NotifySecret) : {};
  }
  cached = buildDeps(secret, table);
  return cached;
}

export async function handler(event: unknown): Promise<DispatchReport> {
  return dispatch(event, await deps());
}
