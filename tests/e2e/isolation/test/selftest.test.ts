/**
 * Self-test: runs the real isolation probes against in-memory fakes, no network and no AWS.
 * Proves (1) the probes pass on a correctly isolated system, and (2) every probe family FAILS when a specific
 * isolation bug is present. If a case in (2) ever goes green, the dev run could pass while tenants leak.
 */
import { describe, expect, it } from 'vitest';
import { failures, type Finding } from '../src/findings.js';
import { runDataPlaneProbes, type DataPlaneProbeConfig } from '../src/probes/data-plane.js';
import { runRealtimeProbes, type RealtimeProbeConfig } from '../src/probes/realtime.js';
import { runToolApiProbes, type ToolApiProbeConfig } from '../src/probes/tool-api.js';
import {
  SEED, fakeDataPlane, fakeJwt, fakeRealtime, fakeToolApi, mintToken,
  type DataPlaneMode, type RealtimeMode, type ToolApiMode,
} from './fakes.js';

const names = (f: Finding[]) => failures(f).map((x) => x.check);

describe('tool API probes', () => {
  const cfg: ToolApiProbeConfig = {
    a: { tenantId: SEED.a.tenantId, token: mintToken(SEED.a.tenantId) },
    b: { tenantId: SEED.b.tenantId, token: mintToken(SEED.b.tenantId), bookingId: SEED.b.bookingId, serviceId: SEED.b.serviceId, number: SEED.b.number },
    markers: [...SEED.markers],
    canary: 'isolation-canary-selftest',
  };

  it('passes on a correctly isolated API, and actually exercised every route (not vacuous)', async () => {
    const findings = await runToolApiProbes(fakeToolApi('correct'), cfg);
    expect(names(findings)).toEqual([]);
    const checks = findings.map((f) => f.check);
    expect(checks.filter((c) => c.startsWith('tool:')).length).toBeGreaterThanOrEqual(16);
    expect(checks).toEqual(expect.arrayContaining(['control:a-token-works', 'control:b-sees-own-booking', 'token:tampered-tid', 'token:alg-none', 'post:b-booking-untouched', 'post:no-canary-in-b']));
  });

  const broken: Array<[ToolApiMode, string]> = [
    ['trust-body-tenant', 'tool:listBookings'],
    ['global-id-lookup', 'tool:cancelBooking'],
    ['global-id-lookup', 'post:b-booking-untouched'],
    ['global-kb', 'tool:searchKnowledge'],
    ['skip-signature', 'token:tampered-tid'],
    ['accept-alg-none', 'token:alg-none'],
    ['write-to-body-tenant', 'post:no-canary-in-b'],
    ['server-error-on-foreign-ids', 'tool:cancelBooking'],
  ];
  it.each(broken)('FAILS when the API is broken: %s -> %s', async (mode, expected) => {
    expect(names(await runToolApiProbes(fakeToolApi(mode), cfg))).toContain(expected);
  });

  it('FAILS when tenant B has no seeded data (a pass there would prove nothing)', async () => {
    expect(names(await runToolApiProbes(fakeToolApi('seed-missing'), cfg))).toContain('control:b-sees-own-booking');
  });

  it('FAILS when token A is simply rejected (denials would be indistinguishable from a bad token)', async () => {
    expect(names(await runToolApiProbes(fakeToolApi('rejects-everything'), cfg))).toContain('control:a-token-works');
  });
});

describe('data plane (direct AssumeRole) probes', () => {
  const cfg: DataPlaneProbeConfig = {
    a: { tenantId: SEED.a.tenantId }, b: { tenantId: SEED.b.tenantId },
    table: 't1145', bNumber: SEED.b.number, bIdentity: 'telegram#99887766',
  };

  it('passes when IAM only allows the session tenant partition', async () => {
    const findings = await runDataPlaneProbes(fakeDataPlane('correct'), cfg);
    expect(names(findings)).toEqual([]);
    expect(findings.map((f) => f.check)).toEqual(expect.arrayContaining([
      'ddb:control-own-partition', 'ddb:query-foreign-partition', 'ddb:get-foreign-item', 'ddb:query-foreign-gsi1',
      'ddb:scan-table', 'ddb:batch-get-mixed', 'ddb:put-foreign-item', 'ddb:get-route-number', 'ddb:get-route-identity',
    ]));
  });

  const broken: Array<[DataPlaneMode, string]> = [
    ['allow-all', 'ddb:query-foreign-partition'],
    ['allow-all', 'ddb:put-foreign-item'],
    ['prefix-only', 'ddb:query-foreign-partition'],
    ['prefix-only', 'ddb:get-foreign-item'],
    ['prefix-only', 'ddb:batch-get-mixed'],
    ['scan-allowed', 'ddb:scan-table'],
    ['routes-readable', 'ddb:get-route-number'],
    ['routes-readable', 'ddb:get-route-identity'],
  ];
  it.each(broken)('FAILS when IAM is broken: %s -> %s', async (mode, expected) => {
    expect(names(await runDataPlaneProbes(fakeDataPlane(mode), cfg))).toContain(expected);
  });

  it('checks both directions: B -> A as well as A -> B', async () => {
    const checks = (await runDataPlaneProbes(fakeDataPlane('correct'), cfg)).map((f) => f.check);
    expect(checks.some((c) => c.startsWith('ddb[B->A]:'))).toBe(true);
    expect(checks.some((c) => c.startsWith('ddb:'))).toBe(true);
  });

  it('does not accept a non-AccessDenied error as "denied" (wrong table, throttling, validation)', async () => {
    expect(names(await runDataPlaneProbes(fakeDataPlane('wrong-error'), cfg))).toContain('ddb:query-foreign-partition');
  });

  it('FAILS when the control read of the own partition returns nothing (unseeded table)', async () => {
    expect(names(await runDataPlaneProbes(fakeDataPlane('empty-table'), cfg))).toContain('ddb:control-own-partition');
  });
});

describe('realtime (AppSync Events) probes', () => {
  const cfg: RealtimeProbeConfig = {
    a: { tenantId: SEED.a.tenantId, jwt: fakeJwt(SEED.a.tenantId, SEED.a.ownerSub) },
    b: { tenantId: SEED.b.tenantId, jwt: fakeJwt(SEED.b.tenantId, SEED.b.ownerSub), ownerSub: SEED.b.ownerSub },
  };

  it('passes when subscribe is scoped to the caller tenant and owner', async () => {
    const findings = await runRealtimeProbes(fakeRealtime('correct'), cfg);
    expect(names(findings)).toEqual([]);
    expect(findings.map((f) => f.check)).toEqual(expect.arrayContaining([
      'realtime:control-own-channel', 'realtime:subscribe-foreign-tenant', 'realtime:subscribe-foreign-owner-chat',
      'realtime:subscribe-ops-fleet', 'realtime:publish-foreign-tenant',
    ]));
  });

  const broken: Array<[RealtimeMode, string]> = [
    ['any-tenant-channel', 'realtime:subscribe-foreign-tenant'],
    ['any-owner-channel', 'realtime:subscribe-foreign-owner-chat'],
    ['ops-open', 'realtime:subscribe-ops-fleet'],
    ['publish-open', 'realtime:publish-foreign-tenant'],
  ];
  it.each(broken)('FAILS when the authorizer is broken: %s -> %s', async (mode, expected) => {
    expect(names(await runRealtimeProbes(fakeRealtime(mode), cfg))).toContain(expected);
  });

  it('FAILS when even the own channel is refused (the token or channel is wrong, so denials mean nothing)', async () => {
    expect(names(await runRealtimeProbes(fakeRealtime('denies-everything'), cfg))).toContain('realtime:control-own-channel');
  });
});
