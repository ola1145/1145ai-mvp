import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * Wiring of the tool API stack: which Lambda may read which route items (SEC-11, ADR-0003), the stage throttle, and the
 * per-function route name the latency metric (P7-2) is published under. Synthesizes only the stacks ApiStack needs, in
 * memory (no esbuild bundling, nothing reaches AWS). Run with the config in this folder (see vitest.config.ts).
 */

const CDK_DIR = fileURLToPath(new URL('../../../infra/cdk', import.meta.url));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function synth(context: Record<string, unknown> = {}): Promise<Json> {
  const before = process.cwd();
  process.chdir(CDK_DIR); // lib/paths.ts resolves the repo root from cwd when it is imported (cdk runs inside infra/cdk)
  try {
    const [cdk, assertions, api, auth, data, events] = await Promise.all([
      import('aws-cdk-lib'), import('aws-cdk-lib/assertions'), import('../../../infra/cdk/lib/api-stack.js'),
      import('../../../infra/cdk/lib/auth-stack.js'), import('../../../infra/cdk/lib/data-stack.js'), import('../../../infra/cdk/lib/events-stack.js'),
    ]);
    const app = new cdk.App({ context: { stage: 'dev', 'aws:cdk:bundling-stacks': [], 'aws:cdk:disable-asset-staging': true, ...context } });
    const env = { account: '111111111111', region: 'us-east-1' };
    const d = new data.DataStack(app, 'ai1145-dev-data', { env });
    const e = new events.EventsStack(app, 'ai1145-dev-events', { env });
    const a = new auth.AuthStack(app, 'ai1145-dev-auth', { env, data: d, stage: 'dev' });
    const stack = new api.ApiStack(app, 'ai1145-dev-api', { env, data: d, events: e, auth: a });
    return assertions.Template.fromStack(stack).toJSON() as Json;
  } finally {
    process.chdir(before);
  }
}

interface Fn { route: string; env: Record<string, unknown>; statements: Json[] }

/** Every tool API function, with the statements of the policies attached to its role. */
function functionsOf(template: Json): Fn[] {
  const resources = Object.entries(template.Resources as Record<string, Json>);
  const policies = resources.filter(([, r]) => r.Type === 'AWS::IAM::Policy').map(([, r]) => r.Properties as Json);
  const out: Fn[] = [];
  for (const [, r] of resources) {
    if (r.Type !== 'AWS::Lambda::Function') continue;
    const env = (r.Properties.Environment?.Variables ?? {}) as Record<string, unknown>;
    const roleId = (r.Properties.Role as Json)['Fn::GetAtt'][0] as string;
    const statements = policies
      .filter((p) => (p.Roles as Json[]).some((x) => x.Ref === roleId))
      .flatMap((p) => [].concat(p.PolicyDocument.Statement) as Json[]);
    out.push({ route: String(env.TOOL_API_ROUTE ?? ''), env, statements });
  }
  return out;
}

/** The LeadingKeys patterns a function may read through a GetItem/Query statement that is limited by them. */
function routeReads(fn: Fn): string[] {
  return fn.statements
    .filter((s) => s.Effect === 'Allow' && [].concat(s.Action).some((a: string) => a === 'dynamodb:GetItem' || a === 'dynamodb:Query'))
    .flatMap((s) => (s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? []) as string[])
    .filter((p) => !p.startsWith('TENANT#'));
}

const RESOLVER_NUMBER = 'internal-resolve-number';
const RESOLVER_WIDGET = 'internal-resolve-widget';
/** Customer-agent tools. ElevenAgents webhook tools reach these with the engine secret, so they look the agent id up. */
const CUSTOMER_ROUTES = [
  'check-availability', 'create-booking', 'reschedule-booking', 'cancel-booking', 'take-message', 'search-knowledge', 'lookup-caller', 'request-handoff',
];
const ADMIN_ROUTES = [
  'admin-summary', 'admin-list-bookings', 'admin-list-conversations', 'admin-propose-change', 'admin-apply-change', 'admin-update-hours', 'admin-update-service',
];

const template = await synth();
const fns = functionsOf(template);
const byRoute = (route: string) => {
  const fn = fns.find((f) => f.route === route);
  if (!fn) throw new Error(`no function with TOOL_API_ROUTE=${route}`);
  return fn;
};

describe('route names for the latency metric (P7-2)', () => {
  it('gives every function its handler file name, which is the Route dimension of ToolLatencyMs', () => {
    expect(fns.map((f) => f.route).sort()).toEqual([...CUSTOMER_ROUTES, ...ADMIN_ROUTES, RESOLVER_NUMBER, RESOLVER_WIDGET].sort());
  });
  it('covers every route the latency alarms watch', async () => {
    const before = process.cwd();
    process.chdir(CDK_DIR);
    try {
      const { VOICE_TOOL_ROUTES } = await import('../../../infra/cdk/lib/observability-stack.js');
      for (const r of VOICE_TOOL_ROUTES) expect(fns.map((f) => f.route), r).toContain(r);
    } finally { process.chdir(before); }
  });
});

describe('route item reads (SEC-11, ADR-0003: only what each function needs)', () => {
  it('lets the number resolver read NUMBER# items and nothing else', () => {
    expect(routeReads(byRoute(RESOLVER_NUMBER))).toEqual(['NUMBER#*']);
  });
  it('lets the widget resolver read WIDGET# items and nothing else', () => {
    expect(routeReads(byRoute(RESOLVER_WIDGET))).toEqual(['WIDGET#*']);
  });
  it.each(CUSTOMER_ROUTES)('lets %s read only the ElevenAgents agent route', (route) => {
    expect(routeReads(byRoute(route))).toEqual(['ENGINEAGENT#*']);
  });
  it.each(ADMIN_ROUTES)('gives %s no route reads at all (dashboard and admin agent never come in through the engine)', (route) => {
    expect(routeReads(byRoute(route))).toEqual([]);
  });
  it('never hands out sign-up, referral or identity routes to any tool API function', () => {
    for (const fn of fns) for (const p of routeReads(fn)) expect(p, fn.route).not.toMatch(/^(IDENTITY|SIGNUP|REFERRAL)#/);
  });
  it('lets every route reader decrypt the table key (the table uses a customer-managed key)', () => {
    for (const fn of fns.filter((f) => routeReads(f).length)) {
      expect(fn.statements.some((s) => [].concat(s.Action).includes('kms:Decrypt')), fn.route).toBe(true);
    }
  });
});

describe('stage throttling (SEC-11, SEC-25 floor)', () => {
  const stage = (t: Json) => Object.values(t.Resources as Record<string, Json>).find((r) => r.Type === 'AWS::ApiGatewayV2::Stage')!.Properties as Json;

  it('puts a default rate and burst limit on every route of the HTTP API', () => {
    const s = stage(template).DefaultRouteSettings as Json;
    expect(s.ThrottlingRateLimit).toBeGreaterThan(0);
    expect(s.ThrottlingBurstLimit).toBeGreaterThanOrEqual(s.ThrottlingRateLimit);
  });
  it('can be tuned per stage from context', async () => {
    const tuned = stage(await synth({ toolApiThrottleRps: 50, toolApiThrottleBurst: 75 })).DefaultRouteSettings as Json;
    expect(tuned).toMatchObject({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 75 });
  });
  it('ignores a nonsense tuning value instead of switching the limit off', async () => {
    const s = stage(await synth({ toolApiThrottleRps: 'lots', toolApiThrottleBurst: -1 })).DefaultRouteSettings as Json;
    expect(s.ThrottlingRateLimit).toBeGreaterThan(0);
    expect(s.ThrottlingBurstLimit).toBeGreaterThan(0);
  });
});

describe('secrets and knowledge search wiring', () => {
  it('names the step-up keys next to the token keys in the tool API secret description', () => {
    const secret = Object.values(template.Resources as Record<string, Json>).find((r) => r.Type === 'AWS::SecretsManager::Secret')!;
    expect(secret.Properties.Description).toMatch(/stepUpCurrent/);
  });
  it('gives no function vector or embedding permissions unless the knowledge index is configured', () => {
    for (const fn of fns) {
      expect(fn.statements.flatMap((s) => [].concat(s.Action)).filter((a: string) => /^(s3vectors|bedrock):/.test(a)), fn.route).toEqual([]);
      expect(fn.env.KNOWLEDGE_VECTOR_BUCKET, fn.route).toBeUndefined();
    }
  });
  it('gives the knowledge search function, and only it, query access scoped to the index and the embedding model', async () => {
    const configured = functionsOf(await synth({ knowledgeVectorBucket: 'kb-bucket', knowledgeVectorIndex: 'kb-index' }));
    for (const fn of configured) {
      const actions = fn.statements.flatMap((s) => [].concat(s.Action) as string[]).filter((a) => /^(s3vectors|bedrock):/.test(a));
      if (fn.route !== 'search-knowledge') {
        expect(actions, fn.route).toEqual([]);
        expect(fn.env.KNOWLEDGE_VECTOR_BUCKET, fn.route).toBeUndefined();
        continue;
      }
      expect(fn.env).toMatchObject({ KNOWLEDGE_VECTOR_BUCKET: 'kb-bucket', KNOWLEDGE_VECTOR_INDEX: 'kb-index' });
      expect(actions.sort()).toEqual(['bedrock:InvokeModel', 's3vectors:GetVectors', 's3vectors:QueryVectors']);
      for (const s of fn.statements.filter((x) => [].concat(x.Action).some((a: string) => /^(s3vectors|bedrock):/.test(a)))) {
        const resources = JSON.stringify(s.Resource);
        expect(resources).not.toBe('"*"');
        if ([].concat(s.Action).includes('s3vectors:QueryVectors')) expect(resources).toContain('bucket/kb-bucket/index/kb-index');
        if ([].concat(s.Action).includes('bedrock:InvokeModel')) expect(resources).toContain('foundation-model/amazon.titan-embed-text-v2:0');
      }
    }
  });
});

describe('stack context is checked, because it ends up in IAM and CORS', () => {
  it.each([
    [{ knowledgeVectorBucket: 'kb-*', knowledgeVectorIndex: 'kb-index' }, /knowledgeVectorBucket/],
    [{ knowledgeVectorBucket: 'kb-bucket', knowledgeVectorIndex: '../other' }, /knowledgeVectorIndex/],
    [{ dashboardOrigins: '*' }, /dashboardOrigins/],
    [{ dashboardOrigins: 'http://app.example.com' }, /dashboardOrigins/],
    [{ dashboardOrigins: 'https://app.example.com/path' }, /dashboardOrigins/],
  ])('refuses %j', async (context, message) => {
    await expect(synth(context)).rejects.toThrow(message);
  });
});

describe('CORS for the dashboard (CR T3-1: the paging cursor header must be readable)', () => {
  it('stays off until dashboard origins are configured', () => {
    const api = Object.values(template.Resources as Record<string, Json>).find((r) => r.Type === 'AWS::ApiGatewayV2::Api')!;
    expect(api.Properties.CorsConfiguration).toBeUndefined();
  });
  it('exposes X-Next-Cursor and Retry-After to the configured origins only', async () => {
    const t = await synth({ dashboardOrigins: 'https://app.example.com,https://staging.example.com' });
    const api = Object.values(t.Resources as Record<string, Json>).find((r) => r.Type === 'AWS::ApiGatewayV2::Api')!;
    expect(api.Properties.CorsConfiguration.AllowOrigins).toEqual(['https://app.example.com', 'https://staging.example.com']);
    expect(api.Properties.CorsConfiguration.ExposeHeaders).toEqual(expect.arrayContaining(['X-Next-Cursor', 'Retry-After']));
    expect(api.Properties.CorsConfiguration.AllowOrigins).not.toContain('*');
  });
});
