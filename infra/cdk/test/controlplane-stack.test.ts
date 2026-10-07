import { describe, expect, it } from 'vitest';
import { sharedApp } from './helpers/app.js';
import { analyze } from './helpers/scope.js';
import { TENANT_BUCKET, tenantBucketViolations } from './helpers/rules.js';

/**
 * The admin console API (ControlPlaneStack, owner H2): staff-only, SigV4, and the one place that may touch every
 * tenant. Requested in contracts/CHANGE_REQUESTS/H2-3.md.
 */

const built = await sharedApp();
const t = built.templates.controlplane!;
const a = analyze(built);
const routes = () => Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties as { RouteKey: string; AuthorizationType: string });
const consoleStatements = a.byStack('controlplane').filter((s) => s.source.startsWith('ConsoleApiServiceRole') && s.effect === 'Allow');

describe('ControlPlaneStack routes', () => {
  it('requires SigV4 (AWS_IAM) on every /console route', () => {
    const consoleRoutes = routes().filter((r) => r.RouteKey.includes('/console'));
    expect(consoleRoutes.map((r) => r.RouteKey).sort()).toEqual(['GET /console/{proxy+}', 'POST /console/{proxy+}', 'PUT /console/{proxy+}']);
    for (const r of consoleRoutes) expect(r.AuthorizationType, r.RouteKey).toBe('AWS_IAM');
  });

  it('leaves only the Stripe webhook open, because Stripe cannot sign with SigV4 (the handler checks Stripe\'s signature)', () => {
    const open = routes().filter((r) => r.AuthorizationType === 'NONE');
    expect(open.map((r) => r.RouteKey)).toEqual(['POST /stripe/webhook']);
  });

  it('throttles both routes', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 } });
  });

  it('exports the console URL and the invoke policy that staff roles attach', () => {
    t.hasOutput('ConsoleApiUrl', {});
    t.hasOutput('ConsoleInvokePolicyArn', {});
  });

  it('lets the invoke policy call /console/* only, with nothing else in it', () => {
    const [policy] = a.byStack('controlplane').filter((s) => s.source.startsWith('ConsoleInvoke'));
    expect(a.byStack('controlplane').filter((s) => s.source.startsWith('ConsoleInvoke'))).toHaveLength(1);
    expect(policy!.actions).toEqual(['execute-api:Invoke']);
    expect(policy!.resources).toHaveLength(1);
    expect(policy!.resources[0]).toMatch(/\/\*\/\*\/console\/\*$/);
  });
});

describe('console Lambda permissions', () => {
  it('names every DynamoDB action: no dynamodb:* or other wildcard', () => {
    const actions = consoleStatements.flatMap((s) => s.actions).filter((x) => x.startsWith('dynamodb:'));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).not.toContain('*');
  });

  it('limits DynamoDB to named key families, except one Scan statement for the tenant list', () => {
    const ddb = consoleStatements.filter((s) => s.actions.some((x) => x.startsWith('dynamodb:')));
    const [scan, ...limited] = [...ddb].sort((x, y) => Number(Object.keys(y.condition).length === 0) - Number(Object.keys(x.condition).length === 0));
    // Scan cannot carry a LeadingKeys condition, so it is its own statement (see contracts/CHANGE_REQUESTS/H2-2.md).
    expect(scan!.actions).toEqual(['dynamodb:Scan']);
    expect(scan!.condition).toEqual({});
    expect(limited.length).toBeGreaterThan(0);
    for (const s of limited) {
      expect(s.actions).not.toContain('dynamodb:Scan');
      expect(s.condition['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'], JSON.stringify(s)).toBeDefined();
    }
    // The only action without a LeadingKeys condition is Scan.
    expect(ddb.filter((s) => Object.keys(s.condition).length === 0).flatMap((s) => s.actions)).toEqual(['dynamodb:Scan']);
  });

  it('reaches the tenant bucket under tenants/ only, and the audit bucket for writes only', () => {
    expect(tenantBucketViolations(a.byStack('controlplane'))).toEqual([]);
    const onTenantBucket = consoleStatements.filter((s) => s.resources.some((r) => r.startsWith(TENANT_BUCKET)));
    expect(onTenantBucket.length).toBeGreaterThan(0);
    for (const s of onTenantBucket) for (const r of s.resources) expect(r === TENANT_BUCKET || r === `${TENANT_BUCKET}/tenants/*`, r).toBe(true);
    for (const s of consoleStatements.filter((x) => x.resources.some((r) => r.startsWith('AUDIT_BUCKET_ARN')))) {
      for (const action of s.actions) expect(action, 'the audit bucket is append-only').toMatch(/^s3:(PutObject|Abort)/);
    }
  });
});
