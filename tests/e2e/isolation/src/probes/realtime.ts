/**
 * Probe 3: AppSync Events. A Cognito user of tenant A must not subscribe to tenant B's live channel, B's owner
 * chat channel, or the ops channel, and must not publish to B's channel (contracts/realtime/channels.md).
 */
import { fail, pass, type Finding } from '../findings.js';
import type { RealtimePort } from '../types.js';

export interface RealtimeProbeConfig {
  a: { tenantId: string; jwt: string };
  /** `jwt` enables the reverse direction; `ownerSub` enables the owner-chat probe. */
  b: { tenantId: string; jwt?: string; ownerSub?: string };
}

const live = (tid: string) => `/tenants/${tid}/live`;

export async function runRealtimeProbes(port: RealtimePort, cfg: RealtimeProbeConfig): Promise<Finding[]> {
  const out: Finding[] = [];
  const guard = async <T>(check: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { out.push(fail(check, `call failed: ${e instanceof Error ? e.message : String(e)}`)); return null; }
  };
  const mustFail = (check: string, r: { ok: boolean; error?: string } | null, what: string) => {
    if (!r) return;
    out.push(r.ok ? fail(check, `${what} SUCCEEDED but must be denied`) : pass(check, `denied: ${r.error ?? ''}`));
  };

  // Control: A can use its own channel, so a denial below is about the channel and not about a bad token.
  const own = await guard('realtime:control-own-channel', () => port.subscribe(cfg.a.jwt, live(cfg.a.tenantId)));
  if (!own) return out;
  if (!own.ok) {
    out.push(fail('realtime:control-own-channel', `tenant A could not subscribe to its own ${live(cfg.a.tenantId)}: ${own.error}; denials would prove nothing`));
    return out;
  }
  out.push(pass('realtime:control-own-channel'));

  mustFail('realtime:subscribe-foreign-tenant', await guard('realtime:subscribe-foreign-tenant', () => port.subscribe(cfg.a.jwt, live(cfg.b.tenantId))), `subscribe to ${live(cfg.b.tenantId)}`);
  if (cfg.b.ownerSub) {
    const ch = `/owners/${cfg.b.ownerSub}/chat`;
    mustFail('realtime:subscribe-foreign-owner-chat', await guard('realtime:subscribe-foreign-owner-chat', () => port.subscribe(cfg.a.jwt, ch)), `subscribe to ${ch}`);
  }
  mustFail('realtime:subscribe-ops-fleet', await guard('realtime:subscribe-ops-fleet', () => port.subscribe(cfg.a.jwt, '/ops/fleet')), 'subscribe to /ops/fleet');
  mustFail('realtime:publish-foreign-tenant', await guard('realtime:publish-foreign-tenant', () => port.publish(cfg.a.jwt, live(cfg.b.tenantId), { type: 'isolation.probe' })), `publish to ${live(cfg.b.tenantId)}`);

  if (cfg.b.jwt) {
    const ownB = await guard('realtime[B->A]:control-own-channel', () => port.subscribe(cfg.b.jwt!, live(cfg.b.tenantId)));
    if (ownB && !ownB.ok) out.push(fail('realtime[B->A]:control-own-channel', `tenant B could not subscribe to its own channel: ${ownB.error}`));
    else if (ownB) {
      out.push(pass('realtime[B->A]:control-own-channel'));
      mustFail('realtime[B->A]:subscribe-foreign-tenant', await guard('realtime[B->A]:subscribe-foreign-tenant', () => port.subscribe(cfg.b.jwt!, live(cfg.a.tenantId))), `subscribe to ${live(cfg.a.tenantId)}`);
    }
  }
  return out;
}
