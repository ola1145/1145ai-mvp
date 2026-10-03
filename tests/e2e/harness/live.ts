/**
 * Live adapters: the same ports as the fake, pointed at the deployed DEV stack.
 *
 * What is wired here is only what the frozen contracts (contracts/openapi/channels.yaml) fully define over plain
 * HTTP: the referral redirect, the public web chat token, and the owner chat POST. Everything that needs the
 * deployed environment or a paid/third-party API is a NotWired port. It throws NotWiredError with the follow-up
 * named, and run-live.ts reports it loudly instead of pretending it passed:
 *
 *   - owner/customer chat replies   : arrive over AppSync Events (/owners/<sub>/chat) and a LiveKit text room
 *   - Telegram test chat            : Bot API test chat + shared bot (TELEGRAM_BOT_TOKEN, a dev chat id)
 *   - phone                         : Telnyx outbound call to the tenant DID, scripted TTS caller (places real calls)
 *   - live events                   : AppSync Events subscription on /tenants/<tid>/live
 *   - platform verification         : a read path for tenant, bookings, call records (dev-only test API or DynamoDB read role)
 *   - Stripe test card, Cognito test identity minting
 *
 * Safety: only the dev stage is accepted, and the API base must not look like prod.
 */
import type { GatePorts } from './ports.ts';

export class NotWiredError extends Error {
  readonly port: string;
  constructor(port: string, followUp: string) {
    super(`${port} is not wired to the dev environment yet: ${followUp}`);
    this.name = 'NotWiredError';
    this.port = port;
  }
}

export interface LiveConfig {
  stage: 'dev';
  /** Base URL of the dev channels API, no trailing slash. */
  apiBase: string;
  /** Cognito ID token of the dedicated e2e owner identity (Google sign-in is replaced by this). */
  ownerToken: string;
}

export type ConfigResult = { ok: true; config: LiveConfig } | { ok: false; missing: string[]; problems: string[] };

export function loadLiveConfig(env: Record<string, string | undefined>): ConfigResult {
  const missing = ['E2E_API_BASE', 'E2E_OWNER_TOKEN'].filter((k) => !env[k]?.trim());
  const problems: string[] = [];
  const stage = env.E2E_STAGE ?? 'dev';
  if (stage !== 'dev') problems.push(`E2E_STAGE is "${stage}"; the e2e harness only runs against dev`);
  const base = (env.E2E_API_BASE ?? '').trim().replace(/\/+$/, '');
  if (base) {
    if (!/^https:\/\//.test(base)) problems.push('E2E_API_BASE must be an https URL');
    if (/(^|[./-])prod(uction)?([./-]|$)/i.test(base)) problems.push('E2E_API_BASE looks like production; refusing to run');
  }
  if (missing.length || problems.length) return { ok: false, missing, problems };
  return { ok: true, config: { stage: 'dev', apiBase: base, ownerToken: env.E2E_OWNER_TOKEN!.trim() } };
}

type Fetch = typeof fetch;

export function createLivePorts(config: LiveConfig, fetchImpl: Fetch = fetch): GatePorts {
  const url = (path: string) => `${config.apiBase}${path}`;
  const notWired = (port: string, followUp: string) => async (): Promise<never> => { throw new NotWiredError(port, followUp); };

  return {
    referral: {
      async follow(code) {
        const res = await fetchImpl(url(`/r/${encodeURIComponent(code)}`), { redirect: 'manual' });
        return { status: res.status, location: res.headers.get('location') ?? '' };
      },
    },
    owner: {
      signIn: async () => ({ ownerId: ownerIdFromToken(config.ownerToken) }),
      addTestCard: notWired('owner.addTestCard', 'Stripe test-mode card via the billing API (needs the deployed billing stack)'),
      send: async (text, opts) => {
        // Contract: POST /v1/owner-chat/messages { text, clientMessageId, referralCode? } -> 202. The tenant is never sent.
        const res = await fetchImpl(url('/v1/owner-chat/messages'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ownerToken}` },
          body: JSON.stringify({ text, clientMessageId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...(opts?.referralCode ? { referralCode: opts.referralCode } : {}) }),
        });
        if (res.status !== 202) throw new Error(`owner chat POST answered ${res.status}, expected 202`);
        throw new NotWiredError('owner.send (reply)', 'the reply arrives on AppSync Events /owners/<sub>/chat; subscribe and collect it');
      },
    },
    customerChat: {
      async open(widgetKey) {
        // Contract: POST /v1/webchat/token { widgetKey } only. The tenant is resolved server-side.
        const res = await fetchImpl(url('/v1/webchat/token'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ widgetKey }) });
        if (res.status !== 200) throw new Error(`webchat token answered ${res.status}, expected 200`);
        const body = (await res.json()) as { agentName?: string; greeting?: string };
        return { agentName: body.agentName ?? '', greeting: body.greeting ?? '' };
      },
      send: notWired('customerChat.send', 'join the LiveKit text room with the returned token and read the agent reply'),
    },
    telegram: { waitForMessage: notWired('telegram', 'Bot API test chat with the shared dev bot (TELEGRAM_BOT_TOKEN, dev chat id)') },
    phone: { call: notWired('phone', 'Telnyx outbound call to the tenant DID with a scripted TTS caller; places real calls, needs owner sign-off on the test numbers') },
    live: { waitForEvent: notWired('live', 'AppSync Events subscription on /tenants/<tid>/live') },
    platform: {
      getTenant: notWired('platform.getTenant', 'dev-only read path for tenant state (test API or read-only role)'),
      listBookings: notWired('platform.listBookings', 'dev-only read path for bookings'),
      getCall: notWired('platform.getCall', 'dev-only read path for call transcript, summary and usage'),
    },
  };
}

/** Which ports still throw NotWiredError. Probed by name so run-live.ts can say exactly what is missing. */
export const LIVE_NOT_WIRED = [
  'owner.addTestCard', 'owner.send (reply)', 'customerChat.send', 'telegram', 'phone', 'live',
  'platform.getTenant', 'platform.listBookings', 'platform.getCall',
] as const;

/** The `sub` claim of the e2e owner's Cognito token (unverified decode; the API verifies it). Falls back to a label. */
function ownerIdFromToken(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string };
    return payload.sub ?? 'e2e-owner';
  } catch {
    return 'e2e-owner';
  }
}
