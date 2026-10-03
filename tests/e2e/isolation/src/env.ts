/**
 * Reads the dev stack's endpoints, roles and fixtures from environment variables. Nothing is hard-coded and no
 * secret lives in the repo. A suite whose variables are all absent is SKIPPED with a message naming them; a suite
 * that is half configured, or configured with nonsense (A equals B), is a hard error so it can never pass vacuously.
 */
import { randomUUID } from 'node:crypto';
import type { AwsCreds } from './sigv4.js';
import type { DataPlaneProbeConfig } from './probes/data-plane.js';
import type { RealtimeProbeConfig } from './probes/realtime.js';
import type { ToolApiProbeConfig } from './probes/tool-api.js';

export type Env = Record<string, string | undefined>;
export type Suite<T> = { ok: true; cfg: T } | { ok: false; kind: 'missing' | 'invalid'; reason: string };

export type ToolApiEnv = ToolApiProbeConfig & { apiUrl: string };
export type DataPlaneEnv = DataPlaneProbeConfig & { roleArn: string; region: string; creds: AwsCreds };
export type RealtimeEnv = RealtimeProbeConfig & { httpHost: string; realtimeHost: string };

export interface IsolationEnv {
  toolApi: Suite<ToolApiEnv>;
  dataPlane: Suite<DataPlaneEnv>;
  realtime: Suite<RealtimeEnv>;
  anyConfigured: boolean;
  /** ISOLATION_REQUIRE=1 (nightly and post-deploy CI): a skipped suite is a failure. */
  required: boolean;
}

const TENANT_ID_RE = /^t_[a-z0-9]{8,40}$/;
const MIN_MARKER_LEN = 5;

export const ENV_DOC = {
  toolApi: ['ISOLATION_API_URL', 'ISOLATION_A_TENANT_ID', 'ISOLATION_B_TENANT_ID', 'ISOLATION_A_TOKEN', 'ISOLATION_B_TOKEN', 'ISOLATION_B_BOOKING_ID', 'ISOLATION_B_SERVICE_ID', 'ISOLATION_B_MARKERS'],
  dataPlane: ['ISOLATION_ASSUME_ROLE_ARN', 'ISOLATION_A_TENANT_ID', 'ISOLATION_B_TENANT_ID', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  realtime: ['ISOLATION_APPSYNC_HTTP_HOST', 'ISOLATION_A_TENANT_ID', 'ISOLATION_B_TENANT_ID', 'ISOLATION_A_COGNITO_JWT'],
} as const;

/** Variables that only this suite uses. If any is set, the suite is considered intended and must be complete. */
const SUITE_SPECIFIC = {
  toolApi: ['ISOLATION_API_URL', 'ISOLATION_A_TOKEN', 'ISOLATION_B_TOKEN', 'ISOLATION_B_BOOKING_ID', 'ISOLATION_B_SERVICE_ID', 'ISOLATION_B_MARKERS'],
  dataPlane: ['ISOLATION_ASSUME_ROLE_ARN'],
  realtime: ['ISOLATION_APPSYNC_HTTP_HOST', 'ISOLATION_A_COGNITO_JWT'],
} as const;

function gate<T>(name: keyof typeof ENV_DOC, env: Env, build: (get: (k: string) => string) => T | string): Suite<T> {
  const get = (k: string): string => (env[k] ?? '').trim();
  const aliases: Record<string, string[]> = { AWS_REGION: ['AWS_REGION', 'AWS_DEFAULT_REGION'] };
  const has = (k: string) => (aliases[k] ?? [k]).some((a) => get(a) !== '');
  const missing = ENV_DOC[name].filter((k) => !has(k));
  const intended = SUITE_SPECIFIC[name].some(has);
  if (missing.length > 0) {
    return intended
      ? { ok: false, kind: 'invalid', reason: `${name} is partly configured; also set: ${missing.join(', ')}` }
      : { ok: false, kind: 'missing', reason: `${name} suite not configured; set ${missing.join(', ')}` };
  }
  const built = build((k) => (aliases[k] ?? [k]).map(get).find((v) => v !== '') ?? '');
  return typeof built === 'string' ? { ok: false, kind: 'invalid', reason: `${name}: ${built}` } : { ok: true, cfg: built };
}

function tenants(get: (k: string) => string): { a: string; b: string } | string {
  const a = get('ISOLATION_A_TENANT_ID'); const b = get('ISOLATION_B_TENANT_ID');
  if (!TENANT_ID_RE.test(a) || !TENANT_ID_RE.test(b)) return 'tenant ids must look like t_<8-40 lowercase alphanumerics>';
  if (a === b) return 'ISOLATION_A_TENANT_ID and ISOLATION_B_TENANT_ID are the same tenant, so every check would pass vacuously';
  return { a, b };
}

export function loadIsolationEnv(env: Env): IsolationEnv {
  const toolApi = gate<ToolApiEnv>('toolApi', env, (get) => {
    const t = tenants(get); if (typeof t === 'string') return t;
    if (get('ISOLATION_A_TOKEN') === get('ISOLATION_B_TOKEN')) return 'ISOLATION_A_TOKEN and ISOLATION_B_TOKEN are identical';
    const markers = get('ISOLATION_B_MARKERS').split(',').map((m) => m.trim()).filter(Boolean);
    if (markers.length === 0) return 'ISOLATION_B_MARKERS needs at least one string that exists only in tenant B data';
    const short = markers.filter((m) => m.length < MIN_MARKER_LEN);
    if (short.length) return `markers must be at least ${MIN_MARKER_LEN} characters to avoid false positives: ${short.join(', ')}`;
    let apiUrl = get('ISOLATION_API_URL');
    try { apiUrl = new URL(apiUrl).toString().replace(/\/$/, ''); } catch { return 'ISOLATION_API_URL is not a URL'; }
    return {
      apiUrl,
      a: { tenantId: t.a, token: get('ISOLATION_A_TOKEN') },
      b: { tenantId: t.b, token: get('ISOLATION_B_TOKEN'), bookingId: get('ISOLATION_B_BOOKING_ID'), serviceId: get('ISOLATION_B_SERVICE_ID'), number: get('ISOLATION_B_NUMBER') || undefined },
      markers,
      canary: `isolation-canary-${randomUUID().slice(0, 8)}`,
    };
  });

  const dataPlane = gate<DataPlaneEnv>('dataPlane', env, (get) => {
    const t = tenants(get); if (typeof t === 'string') return t;
    const roleArn = get('ISOLATION_ASSUME_ROLE_ARN');
    if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(roleArn)) return 'ISOLATION_ASSUME_ROLE_ARN is not an IAM role ARN';
    return {
      roleArn, region: get('AWS_REGION'),
      creds: { accessKeyId: get('AWS_ACCESS_KEY_ID'), secretAccessKey: get('AWS_SECRET_ACCESS_KEY'), sessionToken: get('AWS_SESSION_TOKEN') || undefined },
      a: { tenantId: t.a }, b: { tenantId: t.b },
      table: get('ISOLATION_TABLE') || 't1145',
      bNumber: get('ISOLATION_B_NUMBER') || '+15555550100',
      bIdentity: get('ISOLATION_B_IDENTITY') || 'telegram#isolation-probe',
    };
  });

  const realtime = gate<RealtimeEnv>('realtime', env, (get) => {
    const t = tenants(get); if (typeof t === 'string') return t;
    const httpHost = get('ISOLATION_APPSYNC_HTTP_HOST').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/\.appsync-api\./.test(httpHost) && !get('ISOLATION_APPSYNC_REALTIME_HOST')) return 'ISOLATION_APPSYNC_HTTP_HOST should be <id>.appsync-api.<region>.amazonaws.com (or set ISOLATION_APPSYNC_REALTIME_HOST)';
    const jwtB = get('ISOLATION_B_COGNITO_JWT');
    if (jwtB && jwtB === get('ISOLATION_A_COGNITO_JWT')) return 'ISOLATION_A_COGNITO_JWT and ISOLATION_B_COGNITO_JWT are identical';
    return {
      httpHost,
      realtimeHost: get('ISOLATION_APPSYNC_REALTIME_HOST') || httpHost.replace('.appsync-api.', '.appsync-realtime-api.'),
      a: { tenantId: t.a, jwt: get('ISOLATION_A_COGNITO_JWT') },
      b: { tenantId: t.b, jwt: jwtB || undefined, ownerSub: get('ISOLATION_B_OWNER_SUB') || undefined },
    };
  });

  return {
    toolApi, dataPlane, realtime,
    anyConfigured: [toolApi, dataPlane, realtime].some((s) => s.ok),
    required: env.ISOLATION_REQUIRE === '1',
  };
}
