import { AgentDispatchClient, SipClient, WebhookReceiver } from 'livekit-server-sdk';

export interface LiveKitConnection {
  /** `wss://<project>.livekit.cloud`, or the self-hosted server URL. `ws(s)` is converted to `http(s)` by the SDK. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * The real LiveKit server clients. Constructing them opens no connection; each call is an HTTPS request signed
 * with a short-lived access token minted from the key and secret. The secret stays inside the SDK: it is never put
 * in a request body, a log line or an error message here.
 */
export function createLiveKitClients(c: LiveKitConnection) {
  if (!/^(wss?|https?):\/\/\S+$/.test(c.url ?? '')) throw new Error('LiveKit url must be a ws(s):// or http(s):// URL');
  if (!c.apiKey?.trim()) throw new Error('LiveKit API key is required');
  if (!c.apiSecret?.trim()) throw new Error('LiveKit API secret is required');
  return {
    sip: new SipClient(c.url, c.apiKey, c.apiSecret),
    dispatch: new AgentDispatchClient(c.url, c.apiKey, c.apiSecret),
    webhooks: new WebhookReceiver(c.apiKey, c.apiSecret),
  };
}
