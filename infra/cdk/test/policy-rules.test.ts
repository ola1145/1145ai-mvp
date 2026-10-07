import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { ACCOUNT, REGION, lib } from './helpers/app.js';
import type { Statement } from './helpers/policy.js';
import { auditBucketViolations, crossTenantBucketGrants, crossTenantTableGrants, dynamoViolations, iamWriteGrants, publicAllows, tenantBucketViolations, tenantRoleAssumers } from './helpers/rules.js';
import { analyzeStacks } from './helpers/scope.js';

/**
 * Negative controls. The isolation rules in iam-isolation.test.ts are only worth something if they go red on a bad
 * grant, so this file builds real stacks that grant the table, the buckets and the role the wrong way and checks each
 * rule notices. It also checks the right way (what the stacks use today) passes.
 */

type Grant = (ctx: { data: InstanceType<typeof lib.DataStack>; fn: lambda.Function }) => void;

/** DataStack plus one stack holding one Lambda, given the grant under test. Returns the statements of that Lambda's stack. */
function grantedStatements(grant: Grant): Statement[] {
  const app = new App({ context: { stage: 'dev', 'aws:cdk:bundling-stacks': [] } });
  const env = { account: ACCOUNT, region: REGION };
  const data = new lib.DataStack(app, 'ai1145-dev-data', { env });
  const stack = new Stack(app, 'ai1145-dev-probe', { env });
  const fn = new lambda.Function(stack, 'Probe', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => ({})') });
  grant({ data, fn });
  const a = analyzeStacks(data, { data: Template.fromStack(data), probe: Template.fromStack(stack) });
  return a.byStack('probe');
}

const allow = (actions: string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) =>
  new iam.PolicyStatement({ actions, resources, ...(conditions ? { conditions } : {}) });

describe('DynamoDB rule', () => {
  it('flags the CDK table grants that carry no condition', () => {
    const v = dynamoViolations(grantedStatements(({ data, fn }) => { data.table.grantReadWriteData(fn); }));
    expect(v.map((x) => x.rule).sort()).toContain('dynamodb-no-leading-keys');
    expect(v.flatMap((x) => x.actions)).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Scan']));
  });

  it('flags dynamodb:* even with a LeadingKeys condition (the key is missing for most of what * covers)', () => {
    const grant: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:*'], [data.table.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#t_x'] } }));
    expect(dynamoViolations(grantedStatements(grant)).map((x) => x.rule)).toContain('dynamodb-unlimitable');
  });

  it('flags Scan behind ForAllValues LeadingKeys, because ForAllValues is true when the key is absent', () => {
    const grant: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:Scan'], [data.table.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#t_x'] } }));
    expect(dynamoViolations(grantedStatements(grant)).map((x) => x.rule)).toEqual(['dynamodb-unlimitable']);
  });

  it('flags ForAnyValue, a bare StringLike, and a wildcard-only pattern', () => {
    for (const condition of [
      { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
      { StringLike: { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
      { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*'] } },
      { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*', '*'] } },
      { 'ForAllValues:StringLike': { 'dynamodb:Attributes': ['pk'] } },
    ]) {
      const grant: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:GetItem'], [data.table.tableArn], condition));
      expect(dynamoViolations(grantedStatements(grant)).map((x) => x.rule), JSON.stringify(condition)).toEqual(['dynamodb-no-leading-keys']);
    }
  });

  it('flags a grant on every resource, and on the index', () => {
    expect(dynamoViolations(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['dynamodb:GetItem'], ['*'])))).length).toBe(1);
    expect(dynamoViolations(grantedStatements(({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:Query'], [`${data.table.tableArn}/index/GSI1`])))).length).toBe(1);
    expect(dynamoViolations(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['dynamodb:Query'], ['arn:aws:dynamodb:us-east-1:111111111111:table/*'])))).length).toBe(1);
  });

  it('flags NotAction, which cannot be checked', () => {
    const grant: Grant = ({ data, fn }) => fn.addToRolePolicy(new iam.PolicyStatement({ notActions: ['dynamodb:DeleteTable'], resources: [data.table.tableArn] }));
    expect(dynamoViolations(grantedStatements(grant)).map((x) => x.rule)).toEqual(['dynamodb-not-action']);
  });

  it('passes what the stacks use: route reads, item access limited by ForAllValues LeadingKeys, DescribeTable', () => {
    expect(dynamoViolations(grantedStatements(({ data, fn }) => data.grantRouteRead(fn)))).toEqual([]);
    const grant: Grant = ({ data, fn }) => {
      fn.addToRolePolicy(allow(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'], [data.table.tableArn, `${data.table.tableArn}/index/GSI1`], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } }));
      fn.addToRolePolicy(allow(['dynamodb:DescribeTable'], [data.table.tableArn]));
    };
    expect(dynamoViolations(grantedStatements(grant))).toEqual([]);
  });

  it('calls a TENANT#<wildcard> pattern a cross-tenant grant, and a route read not one', () => {
    const wide: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:GetItem'], [data.table.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } }));
    expect(crossTenantTableGrants(grantedStatements(wide))).toHaveLength(1);
    expect(crossTenantTableGrants(grantedStatements(({ data, fn }) => data.grantRouteRead(fn)))).toEqual([]);
    const own: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['dynamodb:GetItem'], [data.table.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenant_id}'] } }));
    expect(crossTenantTableGrants(grantedStatements(own))).toEqual([]);
  });
});

describe('tenant bucket rule', () => {
  it('flags grants over the whole bucket', () => {
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantRead(fn))).length).toBeGreaterThan(0);
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantReadWrite(fn))).length).toBeGreaterThan(0);
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantPut(fn))).length).toBeGreaterThan(0);
  });

  it('flags s3:* and other resources that cover the bucket', () => {
    const star: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['s3:*'], [`${data.tenantBucket.bucketArn}/tenants/*`]));
    expect(tenantBucketViolations(grantedStatements(star)).map((x) => x.why).join()).toContain('s3:*');
    expect(tenantBucketViolations(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['s3:GetObject'], ['*'])))).length).toBe(1);
    expect(tenantBucketViolations(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['s3:GetObject'], ['arn:aws:s3:::*/*'])))).length).toBe(1);
  });

  it('flags bucket-level writes and objects outside tenants/', () => {
    const admin: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['s3:PutBucketPolicy'], [data.tenantBucket.bucketArn]));
    expect(tenantBucketViolations(grantedStatements(admin)).map((x) => x.why).join()).toContain('bucket-level');
    const other: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['s3:GetObject'], [`${data.tenantBucket.bucketArn}/exports/*`]));
    expect(tenantBucketViolations(grantedStatements(other)).map((x) => x.why).join()).toContain('outside tenants/');
  });

  it('passes the prefix grants the stacks use', () => {
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantReadWrite(fn, 'tenants/*')))).toEqual([]);
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantPut(fn, 'tenants/*/transcripts/*')))).toEqual([]);
    expect(tenantBucketViolations(grantedStatements(({ data, fn }) => data.tenantBucket.grantRead(fn, 'tenants/*/transcripts/*')))).toEqual([]);
    const own: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['s3:GetObject', 's3:PutObject'], [`${data.tenantBucket.bucketArn}/tenants/\${aws:PrincipalTag/tenant_id}/*`]));
    expect(tenantBucketViolations(grantedStatements(own))).toEqual([]);
  });

  it('calls tenants/<wildcard> and the whole bucket cross-tenant, and the caller-tag prefix not', () => {
    expect(crossTenantBucketGrants(grantedStatements(({ data, fn }) => data.tenantBucket.grantRead(fn, 'tenants/*/transcripts/*')))).toHaveLength(1);
    expect(crossTenantBucketGrants(grantedStatements(({ data, fn }) => data.tenantBucket.grantRead(fn)))).toHaveLength(1);
    const own: Grant = ({ data, fn }) => fn.addToRolePolicy(allow(['s3:GetObject'], [`${data.tenantBucket.bucketArn}/tenants/\${aws:PrincipalTag/tenant_id}/*`]));
    expect(crossTenantBucketGrants(grantedStatements(own))).toEqual([]);
  });
});

describe('audit bucket rule', () => {
  it('flags delete, bypass, wildcard and bucket settings', () => {
    expect(auditBucketViolations(grantedStatements(({ data, fn }) => data.auditBucket.grantReadWrite(fn))).flatMap((x) => x.actions)).toContain('s3:DeleteObject*');
    expect(auditBucketViolations(grantedStatements(({ data, fn }) => data.auditBucket.grantDelete(fn))).length).toBe(1);
    for (const action of ['s3:*', 's3:BypassGovernanceRetention', 's3:DeleteObjectVersion', 's3:PutBucketObjectLockConfiguration', 's3:PutBucketPolicy', 's3:Put*']) {
      const grant: Grant = ({ data, fn }) => fn.addToRolePolicy(allow([action], [`${data.auditBucket.bucketArn}/*`]));
      expect(auditBucketViolations(grantedStatements(grant)).length, action).toBe(1);
    }
  });

  it('passes append-only writes and reads', () => {
    expect(auditBucketViolations(grantedStatements(({ data, fn }) => data.auditBucket.grantPut(fn)))).toEqual([]);
    expect(auditBucketViolations(grantedStatements(({ data, fn }) => data.auditBucket.grantRead(fn)))).toEqual([]);
  });
});

describe('TenantDataRole assumers rule', () => {
  it('finds every way to get the role, and nothing else', () => {
    expect(tenantRoleAssumers(grantedStatements(({ data, fn }) => fn.addToRolePolicy(allow(['sts:AssumeRole', 'sts:TagSession'], [data.tenantDataRole.roleArn]))))).toHaveLength(1);
    expect(tenantRoleAssumers(grantedStatements(({ data, fn }) => data.tenantDataRole.grantAssumeRole(fn.grantPrincipal)))).toHaveLength(1);
    expect(tenantRoleAssumers(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['sts:*'], ['*']))))).toHaveLength(1);
    expect(tenantRoleAssumers(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['sts:AssumeRole'], ['arn:aws:iam::111111111111:role/*']))))).toHaveLength(1);
    expect(tenantRoleAssumers(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['sts:AssumeRole'], ['arn:aws:iam::111111111111:role/some-other-role']))))).toEqual([]);
    expect(tenantRoleAssumers(grantedStatements(({ data, fn }) => data.table.grantReadData(fn)))).toEqual([]);
  });
});

describe('IAM write and public allow rules', () => {
  it('flags IAM write actions', () => {
    for (const action of ['iam:PassRole', 'iam:PutRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:AttachRolePolicy', 'iam:*', '*']) {
      expect(iamWriteGrants(grantedStatements(({ fn }) => fn.addToRolePolicy(allow([action], ['*'])))).length, action).toBe(1);
    }
    expect(iamWriteGrants(grantedStatements(({ fn }) => fn.addToRolePolicy(allow(['iam:GetRole'], ['*']))))).toEqual([]);
  });

  it('flags a resource policy that lets everyone in', () => {
    const open = (cond?: Record<string, Record<string, unknown>>) => (a: { data: InstanceType<typeof lib.DataStack> }) =>
      a.data.tenantBucket.addToResourcePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [a.data.tenantBucket.arnForObjects('*')], principals: [new iam.AnyPrincipal()], ...(cond ? { conditions: cond } : {}) }));
    const app = (grant: ReturnType<typeof open>) => {
      const probe = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      const data = new lib.DataStack(probe, 'ai1145-dev-data', { env: { account: ACCOUNT, region: REGION } });
      grant({ data });
      return analyzeStacks(data, { data: Template.fromStack(data) }).statements;
    };
    expect(publicAllows(app(open()))).toHaveLength(1);
    expect(publicAllows(app(open({ StringEquals: { 'aws:PrincipalOrgID': 'o-abc' } })))).toEqual([]);
    // TLS-only policies are Deny statements and do not count.
    expect(publicAllows(app(() => undefined))).toEqual([]);
  });
});
