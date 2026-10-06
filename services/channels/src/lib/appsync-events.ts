import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface OwnerChatPublisherConfig {
  /** AppSync Events HTTP DNS (EventApi.httpDns), e.g. abc123.appsync-api.us-east-1.amazonaws.com */
  httpDomain: string;
  region: string;
  credentials: () => Promise<AwsCredentials>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Cognito sub (a UUID). Anything else could change which channel we publish to. */
const SUB = /^[A-Za-z0-9_-]{1,128}$/;

type SignInput = Parameters<SignatureV4['presign']>[0];

/**
 * Publish an agent reply for the owner web chat: POST https://<domain>/event, SigV4 (service "appsync"), channel
 * /owners/<sub>/chat (contracts/realtime/channels.md). The subscribe handler only lets that same sub listen.
 */
export function createOwnerChatPublisher(cfg: OwnerChatPublisherConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const signer = new SignatureV4({ service: 'appsync', region: cfg.region, credentials: cfg.credentials, sha256: Sha256 });

  return async function publishOwnerChat(sub: string, text: string, meta: { inReplyTo?: string } = {}): Promise<void> {
    if (!SUB.test(sub)) throw new Error('invalid sub for owner chat channel');
    const now = cfg.now?.() ?? new Date();
    const event = { type: 'chat.reply', version: 1, occurredAt: now.toISOString(), data: { role: 'agent', text, ...(meta.inReplyTo ? { inReplyTo: meta.inReplyTo } : {}) } };
    const body = JSON.stringify({ channel: `/owners/${sub}/chat`, events: [JSON.stringify(event)] });
    const request = {
      method: 'POST', protocol: 'https:', hostname: cfg.httpDomain, path: '/event', query: {},
      headers: { 'content-type': 'application/json', host: cfg.httpDomain },
      body,
    };
    const signed = (await signer.sign(request as unknown as SignInput, { signingDate: now })) as unknown as { headers: Record<string, string> };
    const res = await doFetch(`https://${cfg.httpDomain}/event`, { method: 'POST', headers: signed.headers, body });
    if (!res.ok) throw new Error(`appsync publish failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
}
