/**
 * Telegram signup: single-use link token, the pending identity binding, and the owner's YES / NO.
 * Owner: issue D4 (tasks/D4.md). Callers: api/signup-link.ts, api/signup-callback.ts, the router (YES / NO) and
 * provisioning (`isIdentityConfirmed`, for the 409 identity_not_confirmed rule).
 *
 * The flow, and what stops a forwarded link from binding a stranger's Gmail to the owner's Telegram:
 *  1. signup-link mints a token. Only its SHA-256 is stored (SIGNUP#<hash>/TOKEN). The raw token travels as the OAuth
 *     `state` of a Cognito hosted-UI link that goes to the owner's own chat, never to the agent.
 *  2. The callback exchanges the Google sign-in code, THEN consumes the token with one conditional write that also
 *     records a PENDING binding (ONBOARDING#<id>/BINDING). Whoever consumes the token first holds the pending binding.
 *  3. The chat that asked for the link is shown the masked address and asked YES or NO. Only a YES from that same
 *     channel identity, inside the window, confirms. Provisioning refuses to start until then.
 * A newer link revokes the older one, so a copy someone else holds stops working as soon as the owner asks again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys, sha256Hex } from '@1145/shared';

export const SIGNUP_TTL_SECONDS = 15 * 60;
/** How long the owner has to answer YES / NO after the Google sign-in. */
export const PENDING_BINDING_TTL_SECONDS = 30 * 60;
/** Spent and expired tokens stay readable a day, so a stale link gets a useful answer instead of "not found". */
const KEEP_SPENT_TOKEN_SECONDS = 24 * 3600;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedToken = (token: unknown): token is string => typeof token === 'string' && TOKEN_RE.test(token);

/** The raw token goes in the URL; only its hash is stored (SIGNUP#<sha256>). */
export function newSignupToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

/** PKCE (S256). The verifier stays in the SIGNUP item; only the challenge goes into the link. */
export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface SignupRecord {
  onboardingId: string;
  channel: 'whatsapp' | 'telegram';
  /** Telegram: the user id, which is also the private chat id the router replies to. */
  channelUserId: string;
  /** Epoch seconds. */
  exp: number;
  /** PKCE verifier for the Cognito code exchange. Server-side only. */
  codeVerifier?: string;
}

export interface SignupView {
  record: SignupRecord;
  consumed: boolean;
  /** Replaced by a newer link for the same onboarding (also reads as consumed). */
  revoked: boolean;
}

/** What the callback learned from Google. It becomes the pending binding in the same write that burns the token. */
export interface IdentityClaim {
  record: SignupRecord;
  googleSub: string;
  email: string;
}

export interface SignupStore {
  /**
   * Conditional update: consumed = false AND exp > now  ->  set consumed = true. Returns undefined if not consumable.
   * With a claim, the pending binding is written in the SAME transaction, and only if this token is still the live
   * link for the onboarding and the identity is not already confirmed. All or nothing.
   */
  consume(hash: string, nowSeconds: number, claim?: IdentityClaim): Promise<SignupRecord | undefined>;
  /** Read without consuming: lets the callback pick honest words for a spent link and fetch the PKCE verifier. */
  peek(hash: string): Promise<SignupView | undefined>;
  /** Store a new link as THE live link for its onboarding and revoke the previous one. 'already_confirmed' means nothing live was stored. */
  issue(hash: string, record: SignupRecord, nowSeconds: number): Promise<'issued' | 'already_confirmed'>;
}

export function consumeSignupToken(token: string, store: Pick<SignupStore, 'consume'>, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!isWellFormedToken(token)) return Promise.resolve(undefined);
  return store.consume(sha256Hex(token), nowSeconds);
}

// ───────────────────────── the sign-in link ─────────────────────────

export interface CognitoLinkConfig {
  /** Hosted UI host, e.g. ai1145-dev.auth.us-east-1.amazoncognito.com (no scheme, no path). */
  domain: string;
  clientId: string;
  /** https://<provisioning api>/signup/callback, registered as a callback URL on the app client. */
  redirectUri: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** The link is built from config, but a bad value must fail loudly instead of sending owners somewhere else. */
export function assertHost(domain: string): string {
  if (!HOST_RE.test(domain)) throw new Error('invalid Cognito domain');
  return domain;
}

/** Cognito hosted-UI authorize URL: Google only, basic scopes only, token as OAuth state, PKCE challenge. */
export function buildSignupUrl(cfg: CognitoLinkConfig, token: string, codeChallenge: string): string {
  assertHost(cfg.domain);
  if (!cfg.clientId || !cfg.redirectUri.startsWith('https://')) throw new Error('invalid Cognito link configuration');
  const q: Array<[string, string]> = [
    ['response_type', 'code'], ['client_id', cfg.clientId], ['redirect_uri', cfg.redirectUri],
    ['scope', 'openid email profile'], ['identity_provider', 'Google'],
    ['state', token], ['code_challenge', codeChallenge], ['code_challenge_method', 'S256'],
  ];
  return `https://${cfg.domain}/oauth2/authorize?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// ───────────────────────── words the owner reads ─────────────────────────
// All of these follow 1145-conversation-style (the tests run every one through @1145/conversation-style).

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/** The link goes in its own message, sent with link previews off (see createTelegramPoster). */
export function signupLinkMessage(url: string): string {
  return `Here's your private sign-in link, just for you. It works for ${SIGNUP_TTL_SECONDS / 60} minutes, so please don't forward it.\n${url}`;
}

/**
 * Add-5: after Google sign-in, the binding is PENDING until the owner confirms from the chat that started signup.
 * A forwarded signup link therefore cannot silently bind a stranger's Gmail to the owner's WhatsApp.
 */
export function reverseConfirmationMessage(email: string): string {
  return `Someone just signed in to 1145 as ${maskEmail(email)} using your link. If that was you, reply YES. If not, reply NO and we'll cancel it.`;
}

export const bindingReplies = {
  confirmed: "Thanks, that's confirmed. Let's keep going.",
  cancelled: "Okay, I've cancelled that sign-in and nothing was linked. Tell me when you want a fresh link.",
  expired: 'That one timed out, so nothing was linked. Tell me when you want a fresh link.',
} as const;

// ───────────────────────── the binding and the owner's answer ─────────────────────────

export type BindingStatus = 'pending' | 'confirmed' | 'cancelled';

export interface Binding {
  onboardingId: string;
  status: BindingStatus;
  channel: SignupRecord['channel'];
  channelUserId: string;
  googleSub: string;
  email: string;
  /** Epoch seconds; a YES after this confirms nothing. */
  pendingUntil?: number;
  confirmedAt?: string;
}

export interface ChannelIdentity { channel: string; channelUserId: string }

export interface BindingStore {
  /** The binding written by a claim; undefined until someone has signed in with a link. */
  get(onboardingId: string): Promise<Binding | undefined>;
  /**
   * pending -> confirmed | cancelled, as one conditional write: still pending, inside the window, and `who` is the
   * channel identity the link was sent to. Returns false when any of that is not true.
   */
  settle(onboardingId: string, to: 'confirmed' | 'cancelled', who: ChannelIdentity, nowSeconds: number): Promise<boolean>;
}

/** Provisioning's 409 rule: no number, no scraping, no agent until the owner has said YES. */
export async function isIdentityConfirmed(store: Pick<BindingStore, 'get'>, onboardingId: string): Promise<boolean> {
  return (await store.get(onboardingId))?.status === 'confirmed';
}

/** Only a plain yes or no counts. "yes, and my hours are 9 to 5" is a message for the agent, not an answer. */
export function parseBindingReply(text: string): 'yes' | 'no' | undefined {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (/^(y|yes|yep|yeah|yup)$/.test(t)) return 'yes';
  if (/^(n|no|nope|nah)$/.test(t)) return 'no';
  return undefined;
}

export type BindingAnswer =
  | { handled: false }
  | { handled: true; outcome: 'confirmed' | 'cancelled' | 'expired'; reply: string };

/**
 * Deterministic YES / NO for a pending binding (SEC-20). The router calls this with values from the VERIFIED inbound
 * message and its identity route, before any agent runs; the model never decides. `handled: false` means "not for
 * me, carry on to the agent": nothing pending, not a plain yes/no, or it came from some other chat identity.
 */
export async function answerPendingBinding(
  input: { onboardingId: string; channel: string; channelUserId: string; text: string },
  store: BindingStore,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<BindingAnswer> {
  const answer = parseBindingReply(input.text);
  if (!answer) return { handled: false };
  const binding = await store.get(input.onboardingId);
  if (!binding || binding.status !== 'pending') return { handled: false };
  if (binding.channel !== input.channel || binding.channelUserId !== input.channelUserId) return { handled: false };
  if ((binding.pendingUntil ?? 0) <= nowSeconds) return { handled: true, outcome: 'expired', reply: bindingReplies.expired };

  const to = answer === 'yes' ? 'confirmed' : 'cancelled';
  const settled = await store.settle(input.onboardingId, to, { channel: input.channel, channelUserId: input.channelUserId }, nowSeconds);
  // Lost a race or the window closed between the read and the write: nothing was linked either way.
  if (!settled) return { handled: true, outcome: 'expired', reply: bindingReplies.expired };
  return { handled: true, outcome: to, reply: bindingReplies[to] };
}

// ───────────────────────── DynamoDB ─────────────────────────

/** The slice of DynamoDBDocumentClient we use, so tests can pass a fake. */
export interface DocClient { send(command: unknown): Promise<unknown> }

export interface SignupStoreConfig {
  doc: DocClient;
  tableName: string;
  now?: () => Date;
}

// Keys: SIGNUP#<hash>/TOKEN is in contracts/dynamodb/keys.md. The binding lives next to the onboarding record
// (ONBOARDING#<id>/BINDING) so one IAM prefix covers it; see contracts/CHANGE_REQUESTS/D4-1.md.
const ONBOARDING_ID = /^[A-Za-z0-9_-]{1,64}$/;
const signupKey = (hash: string) => ({ PK: keys.signupPk(hash), SK: 'TOKEN' });
const bindingKey = (onboardingId: string) => {
  if (!ONBOARDING_ID.test(onboardingId)) throw new Error('invalid key segment: onboardingId');
  return { PK: `ONBOARDING#${onboardingId}`, SK: 'BINDING' };
};

const errName = (e: unknown) => (e as { name?: string } | undefined)?.name;
const conditionFailed = (e: unknown) => errName(e) === 'ConditionalCheckFailedException' || errName(e) === 'TransactionCanceledException';
/** Every attribute goes through a name placeholder, so no attribute can collide with a DynamoDB reserved word. */
const names = (...attrs: string[]) => Object.fromEntries(attrs.map((a) => [`#${a}`, a]));

export function createSignupStores(cfg: SignupStoreConfig): { signups: SignupStore; bindings: BindingStore } {
  const { doc, tableName: TableName } = cfg;
  const now = cfg.now ?? (() => new Date());

  async function revoke(hash: string): Promise<void> {
    try {
      await doc.send(new UpdateCommand({
        TableName, Key: signupKey(hash),
        UpdateExpression: 'SET #consumed = :t, #revoked = :t',
        ConditionExpression: 'attribute_exists(PK) AND #consumed = :f',
        ExpressionAttributeNames: names('consumed', 'revoked'),
        ExpressionAttributeValues: { ':t': true, ':f': false },
      }));
    } catch (err) {
      // Spent already, or gone: nothing to revoke. Anything else is logged; the binding only accepts the live link
      // anyway, so a link that survives here still cannot claim.
      if (!conditionFailed(err)) console.error(JSON.stringify({ level: 'warn', message: 'could not revoke the replaced signup link', err: errName(err) }));
    }
  }

  const signups: SignupStore = {
    async issue(hash, record, nowSeconds) {
      if (record.exp <= nowSeconds) throw new Error('refusing to store a signup link that is already expired');
      await doc.send(new PutCommand({
        TableName,
        Item: {
          ...signupKey(hash),
          onboardingId: record.onboardingId, channel: record.channel, channelUserId: record.channelUserId,
          exp: record.exp, ttl: record.exp + KEEP_SPENT_TOKEN_SECONDS, consumed: false, createdAt: now().toISOString(),
          ...(record.codeVerifier ? { codeVerifier: record.codeVerifier } : {}),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      let previous: string | undefined;
      try {
        const r = (await doc.send(new UpdateCommand({
          TableName, Key: bindingKey(record.onboardingId),
          UpdateExpression: 'SET #liveTokenHash = :h, #onboardingId = :o',
          ConditionExpression: 'attribute_not_exists(#confirmedAt)',
          ExpressionAttributeNames: names('liveTokenHash', 'onboardingId', 'confirmedAt'),
          ExpressionAttributeValues: { ':h': hash, ':o': record.onboardingId },
          ReturnValues: 'UPDATED_OLD',
        }))) as { Attributes?: { liveTokenHash?: unknown } };
        previous = typeof r.Attributes?.liveTokenHash === 'string' ? r.Attributes.liveTokenHash : undefined;
      } catch (err) {
        // The identity is already confirmed. The item stored above is never sent to anyone and expires on its own.
        if (conditionFailed(err)) return 'already_confirmed';
        throw err;
      }
      if (previous && previous !== hash) await revoke(previous);
      return 'issued';
    },

    async peek(hash) {
      const r = (await doc.send(new GetCommand({ TableName, Key: signupKey(hash), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      const i = r.Item;
      if (!i || typeof i.onboardingId !== 'string' || typeof i.channelUserId !== 'string' || typeof i.exp !== 'number') return undefined;
      if (i.channel !== 'telegram' && i.channel !== 'whatsapp') return undefined;
      return {
        record: {
          onboardingId: i.onboardingId, channel: i.channel, channelUserId: i.channelUserId, exp: i.exp,
          ...(typeof i.codeVerifier === 'string' ? { codeVerifier: i.codeVerifier } : {}),
        },
        consumed: i.consumed === true,
        revoked: i.revoked === true,
      };
    },

    async consume(hash, nowSeconds, claim) {
      if (!claim) {
        try {
          const r = (await doc.send(new UpdateCommand({
            TableName, Key: signupKey(hash),
            UpdateExpression: 'SET #consumed = :t',
            ConditionExpression: '#consumed = :f AND #exp > :now',
            ExpressionAttributeNames: names('consumed', 'exp'),
            ExpressionAttributeValues: { ':t': true, ':f': false, ':now': nowSeconds },
            ReturnValues: 'ALL_NEW',
          }))) as { Attributes?: Record<string, unknown> };
          const i = r.Attributes;
          if (!i || typeof i.onboardingId !== 'string' || typeof i.channelUserId !== 'string' || typeof i.exp !== 'number') return undefined;
          if (i.channel !== 'telegram' && i.channel !== 'whatsapp') return undefined;
          return {
            onboardingId: i.onboardingId, channel: i.channel, channelUserId: i.channelUserId, exp: i.exp,
            ...(typeof i.codeVerifier === 'string' ? { codeVerifier: i.codeVerifier } : {}),
          };
        } catch (err) {
          if (conditionFailed(err)) return undefined;
          throw err;
        }
      }

      const at = now().toISOString();
      const { record } = claim;
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName, Key: signupKey(hash),
                UpdateExpression: 'SET #consumed = :t, #claimedBy = :sub, #claimedAt = :at',
                ConditionExpression: '#consumed = :f AND #exp > :now',
                ExpressionAttributeNames: names('consumed', 'exp', 'claimedBy', 'claimedAt'),
                ExpressionAttributeValues: { ':t': true, ':f': false, ':now': nowSeconds, ':sub': claim.googleSub, ':at': at },
              },
            },
            {
              Update: {
                TableName, Key: bindingKey(record.onboardingId),
                UpdateExpression: 'SET #status = :pending, #googleSub = :sub, #email = :email, #channel = :ch, #channelUserId = :cu, #pendingUntil = :until, #claimedAt = :at REMOVE #cancelledAt',
                // Only the live link may claim, and never once the identity is confirmed.
                ConditionExpression: '#liveTokenHash = :h AND attribute_not_exists(#confirmedAt)',
                ExpressionAttributeNames: names('status', 'googleSub', 'email', 'channel', 'channelUserId', 'pendingUntil', 'claimedAt', 'cancelledAt', 'liveTokenHash', 'confirmedAt'),
                ExpressionAttributeValues: {
                  ':pending': 'pending', ':sub': claim.googleSub, ':email': claim.email, ':ch': record.channel, ':cu': record.channelUserId,
                  ':until': nowSeconds + PENDING_BINDING_TTL_SECONDS, ':at': at, ':h': hash,
                },
              },
            },
          ],
        }));
        return record;
      } catch (err) {
        if (conditionFailed(err)) return undefined;
        throw err;
      }
    },
  };

  const bindings: BindingStore = {
    async get(onboardingId) {
      const r = (await doc.send(new GetCommand({ TableName, Key: bindingKey(onboardingId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      const i = r.Item;
      if (!i || (i.status !== 'pending' && i.status !== 'confirmed' && i.status !== 'cancelled')) return undefined;
      if (typeof i.googleSub !== 'string' || typeof i.email !== 'string' || typeof i.channelUserId !== 'string') return undefined;
      if (i.channel !== 'telegram' && i.channel !== 'whatsapp') return undefined;
      return {
        onboardingId, status: i.status, channel: i.channel, channelUserId: i.channelUserId, googleSub: i.googleSub, email: i.email,
        ...(typeof i.pendingUntil === 'number' ? { pendingUntil: i.pendingUntil } : {}),
        ...(typeof i.confirmedAt === 'string' ? { confirmedAt: i.confirmedAt } : {}),
      };
    },

    async settle(onboardingId, to, who, nowSeconds) {
      // DynamoDB rejects placeholders that no expression uses, so name exactly the timestamp attribute being set.
      const stamp = to === 'confirmed' ? 'confirmedAt' : 'cancelledAt';
      try {
        await doc.send(new UpdateCommand({
          TableName, Key: bindingKey(onboardingId),
          UpdateExpression: `SET #status = :to, #${stamp} = :at`,
          ConditionExpression: '#status = :pending AND #channel = :ch AND #channelUserId = :cu AND #pendingUntil > :now',
          ExpressionAttributeNames: names('status', stamp, 'channel', 'channelUserId', 'pendingUntil'),
          ExpressionAttributeValues: { ':to': to, ':pending': 'pending', ':ch': who.channel, ':cu': who.channelUserId, ':now': nowSeconds, ':at': now().toISOString() },
        }));
        return true;
      } catch (err) {
        if (conditionFailed(err)) return false;
        throw err;
      }
    },
  };

  return { signups, bindings };
}
