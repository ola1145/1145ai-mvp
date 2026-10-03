import { createHmac } from 'node:crypto';

type Item = Record<string, unknown>;
export interface FakeState { inbound: { items: Item[] }; outbound: { items: Item[] }; dispatch: { items: Item[] } }
export interface Call { method: string; body: Item }

const decode = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/**
 * In-memory stand-in for the LiveKit SIP Twirp API, seeded from a hand-written fixture. It checks the bearer token the
 * way the real server does (HS256 signature, API key as issuer, sip.admin grant) and records every call.
 */
export class FakeLivekit {
  calls: Call[] = [];
  private n = 0;
  constructor(public state: FakeState, private readonly apiKey: string, private readonly apiSecret: string) {}

  get mutations(): Call[] { return this.calls.filter((c) => /^(Create|Update|Delete)/.test(c.method)); }
  clearCalls(): void { this.calls = []; }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.startsWith('/twirp/livekit.SIP/')) return this.json({ code: 'bad_route', msg: url.pathname }, 404);
    const method = url.pathname.replace('/twirp/livekit.SIP/', '');
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const problem = this.checkToken(auth.replace(/^Bearer /, ''));
    if (problem) return this.json({ code: 'unauthenticated', msg: problem }, 401);
    const body = JSON.parse(String(init?.body ?? '{}')) as Item;
    this.calls.push({ method, body });
    return this.json(this.handle(method, body));
  };

  private checkToken(token: string): string | null {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return 'no token';
    const expect = createHmac('sha256', this.apiSecret).update(`${h}.${p}`).digest('base64url');
    if (expect !== sig) return 'bad signature';
    const claims = JSON.parse(decode(p)) as { iss?: string; exp?: number; sip?: { admin?: boolean } };
    if (claims.iss !== this.apiKey) return 'wrong issuer';
    if (!claims.exp || claims.exp * 1000 < Date.now()) return 'expired';
    if (!claims.sip?.admin) return 'missing sip.admin grant';
    return null;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private handle(method: string, body: Item): unknown {
    const id = (prefix: string) => `${prefix}_new${++this.n}`;
    switch (method) {
      case 'ListSIPInboundTrunk': return this.state.inbound;
      case 'ListSIPOutboundTrunk': return this.state.outbound;
      case 'ListSIPDispatchRule': return this.state.dispatch;
      case 'CreateSIPInboundTrunk': { const t = { sipTrunkId: id('ST'), ...(body.trunk as Item) }; this.state.inbound.items.push(t); return t; }
      case 'CreateSIPOutboundTrunk': { const t = { sipTrunkId: id('ST'), ...(body.trunk as Item) }; this.state.outbound.items.push(t); return t; }
      case 'CreateSIPDispatchRule': { const r = { sipDispatchRuleId: id('SDR'), ...body }; this.state.dispatch.items.push(r); return r; }
      case 'UpdateSIPInboundTrunk': return this.replace(this.state.inbound.items, 'sipTrunkId', body);
      case 'UpdateSIPOutboundTrunk': return this.replace(this.state.outbound.items, 'sipTrunkId', body);
      case 'UpdateSIPDispatchRule': return this.replace(this.state.dispatch.items, 'sipDispatchRuleId', body);
      default: throw new Error(`fake does not implement ${method}`);
    }
  }

  private replace(items: Item[], key: string, body: Item): Item {
    const idx = items.findIndex((i) => i[key] === body[key]);
    if (idx < 0) throw new Error(`no such ${key} ${String(body[key])}`);
    const next = { [key]: body[key], ...(body.replace as Item) };
    items[idx] = next;
    return next;
  }
}
