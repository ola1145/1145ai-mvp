/**
 * Cognito redirect: consume token, pending binding, reverse confirmation in Telegram.
 * Owner: issue D4 (tasks/D4.md). Contract: contracts/openapi/onboarding-internal.yaml (GET /signup/callback).
 *
 * Public route (the browser lands here), so everything is derived from two query values and nothing else:
 *  - `state` is the signup token. It is hashed and looked up; the onboarding, chat and channel come from the stored record.
 *  - `code` is the Google sign-in, traded with Cognito for a verified identity before the token is touched, so a
 *    cancelled or failed sign-in does not burn the link (SEC-20).
 * The token is then consumed by one conditional write that also records the PENDING binding. The identity stays
 * unconfirmed until the owner replies YES in the chat that asked for the link (see answerPendingBinding).
 * Pages never echo the token, the code or the address, and are sent no-store with no referrer.
 */
import { sha256Hex } from '@1145/shared';
import {
  assertHost,
  createSignupStores,
  isWellFormedToken,
  reverseConfirmationMessage,
  type SignupStore,
  type SignupView,
} from '../lib/signup-token.js';
import { createRuntime, requiredEnv, type SignupLinkDeps } from './signup-link.js';

export interface GoogleIdentity { sub: string; email: string }

export interface SignupCallbackDeps {
  signups: SignupStore;
  /** Trades the sign-in code for the verified Google identity, or throws. */
  exchangeCode(code: string, codeVerifier: string | undefined): Promise<GoogleIdentity>;
  sendTelegram: SignupLinkDeps['sendTelegram'];
  now?: () => Date;
}

/** What the owner reads in the browser. Short and plain, like everything else we say (1145-conversation-style). */
export const pageCopy = {
  signedIn: "You're signed in. Head back to Telegram and reply YES to confirm it's you.",
  used: "That link's already used. If that wasn't you, tell me in Telegram and I'll send a fresh one.",
  replaced: 'That link was replaced by a newer one. Use the latest one I sent you in Telegram.',
  expired: "That link timed out. Ask me for a fresh one in Telegram and it'll only take a second.",
  badLink: "That link doesn't look right. Ask me for a fresh one in Telegram.",
  signInFailed: "Sign-in didn't finish. Tap the link again when you're ready, it works for a few more minutes.",
  telegramFailed: "You're signed in, but I couldn't reach you on Telegram just now. Ask me for a fresh link there and we'll go again.",
  trouble: 'Something went wrong on our side. Give it a minute, then tap the link again.',
} as const;

interface ApiEvent { queryStringParameters?: Record<string, string | undefined> | null }
interface PageResult { statusCode: number; headers: Record<string, string>; body: string }

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(statusCode: number, text: string): PageResult {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>1145</title>`
      + `<style>body{font:18px/1.5 system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fafafa;color:#1a1a1a}main{max-width:26rem;padding:2rem}</style></head>`
      + `<body><main><p>${escapeHtml(text)}</p></main></body></html>`,
  };
}

/** A link that cannot be used any more, with the words that fit why. */
function deadLink(view: SignupView | undefined, nowSeconds: number): PageResult | undefined {
  if (!view) return page(400, pageCopy.badLink);
  if (view.revoked) return page(410, pageCopy.replaced);
  if (view.consumed) return page(409, pageCopy.used);
  if (view.record.exp <= nowSeconds) return page(410, pageCopy.expired);
  return undefined;
}

const log = (level: 'warn' | 'error', message: string, err?: unknown) =>
  // Never the token, the code or the address: only what went wrong.
  console.error(JSON.stringify({ level, message, err: err instanceof Error ? err.message : undefined }));

export function makeHandler(deps: SignupCallbackDeps) {
  return async function handler(event: unknown): Promise<PageResult> {
    const q = ((event ?? {}) as ApiEvent).queryStringParameters ?? {};
    const state = q.state;
    if (!isWellFormedToken(state)) return page(400, pageCopy.badLink);
    const hash = sha256Hex(state);
    const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);

    try {
      const view = await deps.signups.peek(hash);
      const dead = deadLink(view, nowSeconds);
      if (dead || !view) return dead ?? page(400, pageCopy.badLink);

      // The owner backed out of Google, or the redirect is missing its code: the link stays good.
      if (q.error || typeof q.code !== 'string' || !q.code) return page(400, pageCopy.signInFailed);

      let identity: GoogleIdentity;
      try {
        identity = await deps.exchangeCode(q.code, view.record.codeVerifier);
      } catch (err) {
        log('warn', 'sign-in code exchange failed', err);
        return page(400, pageCopy.signInFailed);
      }

      const consumed = await deps.signups.consume(hash, nowSeconds, { record: view.record, googleSub: identity.sub, email: identity.email });
      if (!consumed) {
        // Someone else got there first (or a newer link replaced this one) between the look and the write.
        return deadLink(await deps.signups.peek(hash), nowSeconds) ?? page(410, pageCopy.replaced);
      }

      try {
        // Destination: the chat the link was minted for, from the stored record. Never anything from this request.
        await deps.sendTelegram(consumed.channelUserId, reverseConfirmationMessage(identity.email));
      } catch (err) {
        log('error', 'reverse confirmation not delivered', err);
        return page(502, pageCopy.telegramFailed);
      }
      return page(200, pageCopy.signedIn);
    } catch (err) {
      log('error', 'signup callback failed', err);
      return page(500, pageCopy.trouble);
    }
  };
}

// ───────────────────────── Cognito code exchange ─────────────────────────

export interface CognitoExchangeConfig {
  domain: string;
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Authorization-code exchange against the Cognito hosted UI token endpoint, with the PKCE verifier we kept.
 * The id token comes straight from Cognito over TLS, so its signature need not be re-verified here (OIDC Core
 * 3.1.3.7); we still require our client as audience, an unexpired token, a subject and a verified email.
 */
export function cognitoCodeExchange(cfg: CognitoExchangeConfig): SignupCallbackDeps['exchangeCode'] {
  const domain = assertHost(cfg.domain);
  const doFetch = cfg.fetchImpl ?? fetch;
  return async (code, codeVerifier) => {
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, code, redirect_uri: cfg.redirectUri });
    if (codeVerifier) form.set('code_verifier', codeVerifier);
    const res = await doFetch(`https://${domain}/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const idToken = ((await res.json().catch(() => ({}))) as { id_token?: unknown }).id_token;
    if (typeof idToken !== 'string') throw new Error('no id token in the response');

    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('unreadable id token');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.clientId)) throw new Error('id token is for another client');
    const nowSeconds = Math.floor((cfg.now?.() ?? new Date()).getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new Error('id token expired');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id token has no subject');
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new Error('id token has no email');
    if (claims.email_verified === false || claims.email_verified === 'false') throw new Error('email is not verified');
    return { sub: claims.sub, email: claims.email };
  };
}

// ───────────────────────── production wiring ─────────────────────────

function buildProd() {
  const rt = createRuntime();
  const { signups } = createSignupStores({ doc: rt.doc, tableName: rt.tableName });
  return makeHandler({
    signups,
    exchangeCode: cognitoCodeExchange({
      domain: requiredEnv(process.env, 'COGNITO_DOMAIN'),
      clientId: requiredEnv(process.env, 'COGNITO_CLIENT_ID'),
      redirectUri: requiredEnv(process.env, 'SIGNUP_REDIRECT_URI'),
    }),
    sendTelegram: rt.sendTelegram,
  });
}

let prod: ReturnType<typeof makeHandler> | undefined;
export async function handler(event: unknown): Promise<PageResult> {
  try {
    prod ??= buildProd();
  } catch (err) {
    log('error', 'signup-callback is not configured', err);
    return page(500, pageCopy.trouble);
  }
  return prod(event);
}
