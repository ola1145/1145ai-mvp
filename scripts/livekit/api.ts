import { createHmac } from 'node:crypto';

/** Protobuf-JSON shapes for the pieces of the LiveKit SIP API this lane uses. Unknown fields pass through untouched. */
export interface InboundTrunk { sipTrunkId?: string; name?: string; numbers?: string[]; allowedAddresses?: string[]; [k: string]: unknown }
export interface OutboundTrunk { sipTrunkId?: string; name?: string; address?: string; transport?: string; numbers?: string[]; authUsername?: string; authPassword?: string; [k: string]: unknown }
export interface DispatchRule {
  sipDispatchRuleId?: string; name?: string; trunkIds?: string[];
  rule?: { dispatchRuleIndividual?: { roomPrefix?: string; pin?: string } };
  roomConfig?: { agents?: { agentName?: string }[] };
  [k: string]: unknown;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function httpUrlFromLivekitUrl(url: string): string {
  return url.trim().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** HS256 access token with the SIP admin grant. Built with node:crypto so the scripts need no extra dependency. */
export function signSipAdminToken(apiKey: string, apiSecret: string, now = Date.now(), ttlSeconds = 60): string {
  const s = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: apiKey, sub: '1145-e1-setup', nbf: s - 5, exp: s + ttlSeconds, sip: { admin: true } }));
  const sig = createHmac('sha256', apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Minimal Twirp client for the livekit.SIP service. The API secret never leaves this class except as a signature. */
export class LivekitSipClient {
  private readonly base: string;
  constructor(url: string, private readonly apiKey: string, private readonly apiSecret: string, private readonly fetchImpl: FetchLike = fetch) {
    this.base = httpUrlFromLivekitUrl(url);
  }

  private async call<T>(method: string, body: object): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/twirp/livekit.SIP/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signSipAdminToken(this.apiKey, this.apiSecret)}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LiveKit ${method} failed with ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listInbound(): Promise<InboundTrunk[]> { return (await this.call<{ items?: InboundTrunk[] }>('ListSIPInboundTrunk', {})).items ?? []; }
  async listOutbound(): Promise<OutboundTrunk[]> { return (await this.call<{ items?: OutboundTrunk[] }>('ListSIPOutboundTrunk', {})).items ?? []; }
  async listDispatchRules(): Promise<DispatchRule[]> { return (await this.call<{ items?: DispatchRule[] }>('ListSIPDispatchRule', {})).items ?? []; }

  createInbound(trunk: InboundTrunk): Promise<InboundTrunk> { return this.call('CreateSIPInboundTrunk', { trunk }); }
  createOutbound(trunk: OutboundTrunk): Promise<OutboundTrunk> { return this.call('CreateSIPOutboundTrunk', { trunk }); }
  createDispatchRule(rule: DispatchRule): Promise<DispatchRule> { return this.call('CreateSIPDispatchRule', rule); }

  updateInbound(sipTrunkId: string, replace: InboundTrunk): Promise<InboundTrunk> { return this.call('UpdateSIPInboundTrunk', { sipTrunkId, replace }); }
  updateOutbound(sipTrunkId: string, replace: OutboundTrunk): Promise<OutboundTrunk> { return this.call('UpdateSIPOutboundTrunk', { sipTrunkId, replace }); }
  updateDispatchRule(sipDispatchRuleId: string, replace: DispatchRule): Promise<DispatchRule> { return this.call('UpdateSIPDispatchRule', { sipDispatchRuleId, replace }); }
}
