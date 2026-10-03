/**
 * Tenant isolation against the REAL dev stack. Endpoints, roles and fixtures come from ISOLATION_* environment
 * variables (see ../README.md). With none set, each suite is skipped and says why. With ISOLATION_REQUIRE=1
 * (nightly and post-deploy CI) a skipped suite fails the run, so the gate can never go green by not running.
 * The probes themselves are proven by selftest.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { appSyncPort } from '../src/adapters/appsync.js';
import { awsDataPlane } from '../src/adapters/aws.js';
import { fetchHttpPort } from '../src/adapters/http.js';
import { loadIsolationEnv, type Suite } from '../src/env.js';
import { describeFailures, failures } from '../src/findings.js';
import { runDataPlaneProbes } from '../src/probes/data-plane.js';
import { runRealtimeProbes } from '../src/probes/realtime.js';
import { runToolApiProbes } from '../src/probes/tool-api.js';

const env = loadIsolationEnv(process.env);

function gateSuite(name: string, s: Suite<unknown>): void {
  if (s.ok) return;
  console.warn(`[isolation] SKIPPED ${name}: ${s.reason}`);
}
gateSuite('tool API', env.toolApi);
gateSuite('data plane', env.dataPlane);
gateSuite('realtime', env.realtime);

describe('isolation environment', () => {
  it('has no half-configured or contradictory suite', () => {
    const bad = [env.toolApi, env.dataPlane, env.realtime].flatMap((s) => (!s.ok && s.kind === 'invalid' ? [s.reason] : []));
    expect(bad).toEqual([]);
  });

  it.runIf(env.required)('has every suite configured (ISOLATION_REQUIRE=1)', () => {
    const missing = [env.toolApi, env.dataPlane, env.realtime].flatMap((s) => (!s.ok ? [s.reason] : []));
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!env.toolApi.ok)('tool API: token A + tenant B ids -> no tenant B data', () => {
  it('holds on every route, under forged tokens, and leaves tenant B untouched', async () => {
    if (!env.toolApi.ok) return;
    const cfg = env.toolApi.cfg;
    const findings = await runToolApiProbes(fetchHttpPort(cfg.apiUrl), cfg);
    expect(describeFailures(findings)).toBe('');
    expect(findings.length).toBeGreaterThan(20);
  });
});

describe.skipIf(!env.dataPlane.ok)('data plane: AssumeRole tag A cannot touch TENANT#B', () => {
  it('is denied by IAM for query, get, GSI, scan, batch, put and route items, both directions', async () => {
    if (!env.dataPlane.ok) return;
    const cfg = env.dataPlane.cfg;
    const findings = await runDataPlaneProbes(awsDataPlane({ roleArn: cfg.roleArn, region: cfg.region, creds: cfg.creds }), cfg);
    expect(describeFailures(findings)).toBe('');
    expect(failures(findings)).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(18);
  });
});

describe.skipIf(!env.realtime.ok)('AppSync: cross-tenant subscribe and publish are denied', () => {
  it('denies foreign tenant, owner chat and ops channels', async () => {
    if (!env.realtime.ok) return;
    const cfg = env.realtime.cfg;
    const findings = await runRealtimeProbes(appSyncPort({ httpHost: cfg.httpHost, realtimeHost: cfg.realtimeHost }), cfg);
    expect(describeFailures(findings)).toBe('');
    expect(findings.length).toBeGreaterThanOrEqual(5);
  });
});
