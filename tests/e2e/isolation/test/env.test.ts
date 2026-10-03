import { describe, expect, it } from 'vitest';
import { loadIsolationEnv } from '../src/env.js';

const base = {
  ISOLATION_API_URL: 'https://api.dev.example.test',
  ISOLATION_A_TENANT_ID: 't_aaaaaaaa1', ISOLATION_B_TENANT_ID: 't_bbbbbbbb1',
  ISOLATION_A_TOKEN: 'tokA', ISOLATION_B_TOKEN: 'tokB',
  ISOLATION_B_BOOKING_ID: 'bk_B_1', ISOLATION_B_SERVICE_ID: 'svc_B_1', ISOLATION_B_MARKERS: 'Zorblax, Quuxington',
  ISOLATION_ASSUME_ROLE_ARN: 'arn:aws:iam::111111111111:role/TenantDataRole', AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret',
  ISOLATION_APPSYNC_HTTP_HOST: 'abc.appsync-api.us-east-1.amazonaws.com', ISOLATION_A_COGNITO_JWT: 'jwtA',
};

describe('loadIsolationEnv', () => {
  it('reports every suite as skipped, naming the missing variables, when nothing is set', () => {
    const e = loadIsolationEnv({});
    expect(e.toolApi.ok).toBe(false);
    expect(e.dataPlane.ok).toBe(false);
    expect(e.realtime.ok).toBe(false);
    if (!e.toolApi.ok) {
      expect(e.toolApi.reason).toContain('ISOLATION_API_URL');
      expect(e.toolApi.reason).toContain('ISOLATION_A_TOKEN');
    }
    expect(e.anyConfigured).toBe(false);
  });

  it('builds all three suites from a full environment and parses markers', () => {
    const e = loadIsolationEnv(base);
    expect(e.toolApi.ok && e.toolApi.cfg.markers).toEqual(['Zorblax', 'Quuxington']);
    expect(e.dataPlane.ok && e.dataPlane.cfg.table).toBe('t1145');
    expect(e.realtime.ok && e.realtime.cfg.a.jwt).toBe('jwtA');
    expect(e.anyConfigured).toBe(true);
  });

  it('refuses identical A and B tenants (the run would pass vacuously)', () => {
    const e = loadIsolationEnv({ ...base, ISOLATION_B_TENANT_ID: base.ISOLATION_A_TENANT_ID });
    expect(e.toolApi.ok).toBe(false);
    expect(e.dataPlane.ok).toBe(false);
    expect(e.realtime.ok).toBe(false);
  });

  it('refuses identical A and B tokens', () => {
    expect(loadIsolationEnv({ ...base, ISOLATION_B_TOKEN: 'tokA' }).toolApi.ok).toBe(false);
  });

  it('refuses markers that are too short to be meaningful (false positives) or empty', () => {
    expect(loadIsolationEnv({ ...base, ISOLATION_B_MARKERS: 'ab' }).toolApi.ok).toBe(false);
    expect(loadIsolationEnv({ ...base, ISOLATION_B_MARKERS: ' , ' }).toolApi.ok).toBe(false);
  });

  it('refuses a malformed tenant id', () => {
    expect(loadIsolationEnv({ ...base, ISOLATION_A_TENANT_ID: 'tenant-a' }).dataPlane.ok).toBe(false);
  });

  it('derives the realtime host from the HTTP host unless overridden', () => {
    const e = loadIsolationEnv(base);
    expect(e.realtime.ok && e.realtime.cfg.realtimeHost).toBe('abc.appsync-realtime-api.us-east-1.amazonaws.com');
  });

  it('requires an explicit opt-in only to make missing env a failure (nightly CI sets ISOLATION_REQUIRE=1)', () => {
    expect(loadIsolationEnv({}).required).toBe(false);
    expect(loadIsolationEnv({ ISOLATION_REQUIRE: '1' }).required).toBe(true);
  });
});
