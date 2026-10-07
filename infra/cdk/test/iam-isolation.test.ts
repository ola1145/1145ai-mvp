import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_STACKS, sharedApp, type Stage } from './helpers/app.js';
import type { Statement } from './helpers/policy.js';
import { analyze } from './helpers/scope.js';
import {
  auditBucketViolations, coversTable, crossTenantBucketGrants, crossTenantTableGrants, dynamoViolations, iamWriteGrants, publicAllows,
  tenantBucketViolations, tenantRoleAssumers, type Violation,
} from './helpers/rules.js';

/**
 * ADR-0003 across the whole app: every stack, every policy statement, dev and prod.
 *
 * The rules live in helpers/rules.ts and are proven to catch bad grants in policy-rules.test.ts. Here they run on the
 * real stacks. Anything that has to stay as an exception is written down in the lists below, with the reason.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Grants on the tenant table that no LeadingKeys condition can limit. Each one needs a reason and a change request,
 * and `actions` is the most that stack may hold: a PR that adds an action fails here.
 */
const ACCEPTED_TABLE_GRANTS: Array<{ stack: string; actions: string[]; reason: string; changeRequest: string }> = [
  {
    stack: 'controlplane',
    actions: ['dynamodb:Scan'],
    reason: 'The admin console lists tenants by scanning PROFILE rows until the tenant index exists. Staff only (IAM auth), never reachable by a tenant.',
    changeRequest: 'contracts/CHANGE_REQUESTS/H2-2.md',
  },
  {
    stack: 'notifications',
    actions: ['dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:ConditionCheckItem', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'],
    reason: 'NotificationsStack uses table.grantReadWriteData, which carries no condition. A Deny on non-TENANT# leading keys sits next to it, but LeadingKeys is not set for Scan, so Scan is still open. Replace it with named actions and a LeadingKeys condition.',
    changeRequest: 'contracts/CHANGE_REQUESTS/P4-2.md',
  },
];

/** The only stacks whose roles may read or write the table across tenants (a TENANT#<wildcard> pattern or no usable limit). */
// postcall: one consumer handles call.ended for every tenant (usage counter, CRM upsert, Stripe usage guard). The tenant
// comes from the event, and only the voice and engine producers may put call.ended (SEC-13).
const CROSS_TENANT_TABLE_STACKS = ['auth', 'provisioning', 'controlplane', 'notifications', 'postcall'];
/** The only stacks whose roles may hold tenant bucket paths that span tenants. Each is limited to a folder or to staff. */
const CROSS_TENANT_BUCKET_STACKS = ['controlplane', 'postcall', 'voice'];
/** The one stack whose roles may assume TenantDataRole, i.e. choose the tenant_id session tag. */
const TENANT_ROLE_ASSUMER_STACKS = ['api'];

const describeViolation = (v: Violation) => `${v.stack}/${v.source}: ${v.rule} [${v.actions.join(', ')}] on ${v.resources.join(', ')}: ${v.why}`;
const describeStatement = (s: Statement) => `${s.stack}/${s.source}: [${s.actions.join(', ')}] on ${s.resources.join(', ')}`;

describe('accepted table grants', () => {
  it('each exception names a reason and a change request that exists', () => {
    for (const e of ACCEPTED_TABLE_GRANTS) {
      expect(e.reason.length, e.stack).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(REPO, e.changeRequest)), `${e.changeRequest} is missing`).toBe(true);
    }
  });
});

const apps = { dev: await sharedApp({ stage: 'dev' }), prod: await sharedApp({ stage: 'prod' }) };

describe.each(['dev', 'prod'] as Stage[])('tenant data access in %s', (stage) => {
  const a = analyze(apps[stage]);

  it('sees the grants it is meant to police', () => {
    // A silent parsing failure would make every other test here pass for the wrong reason.
    expect(a.statements.length).toBeGreaterThan(100);
    const onTable = a.statements.filter((s) => s.actions.some((x) => x.toLowerCase().startsWith('dynamodb:')) && s.resources.some(coversTable));
    expect([...new Set(onTable.map((s) => s.stack))]).toEqual(expect.arrayContaining(['data', 'api', 'auth', 'channels', 'controlplane', 'notifications', 'provisioning']));
    expect(Object.keys(apps[stage].templates)).toEqual(expect.arrayContaining(KNOWN_STACKS));
    expect(a.statements.some((s) => s.resources.some((r) => r.startsWith('TENANT_BUCKET_ARN/')))).toBe(true);
    expect(a.statements.some((s) => s.resources.some((r) => r.startsWith('AUDIT_BUCKET_ARN/')))).toBe(true);
    expect(a.statements.some((s) => s.kind === 'trust')).toBe(true);
  });

  it('gives no principal DynamoDB access to the tenant table without a LeadingKeys condition, except the accepted grants', () => {
    const unexpected = dynamoViolations(a.statements).filter((v) => {
      const accepted = ACCEPTED_TABLE_GRANTS.find((e) => e.stack === v.stack);
      return !accepted || !v.actions.every((x) => accepted.actions.includes(x));
    });
    expect(unexpected.map(describeViolation)).toEqual([]);
  });

  it('keeps the Deny that narrows the notifications dispatcher until it is replaced by a condition', () => {
    const deny = a.byStack('notifications').filter((s) => s.effect === 'Deny' && s.resources.some(coversTable));
    expect(deny).toHaveLength(1);
    expect(deny[0]!.condition).toEqual({ 'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } });
    for (const action of ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem']) {
      expect(deny[0]!.actions).toContain(action);
    }
  });

  it('gives no principal the whole tenant bucket, s3:*, or a path outside tenants/', () => {
    expect(tenantBucketViolations(a.statements).map(describeViolation)).toEqual([]);
  });

  it('keeps the audit bucket append-only: nobody can delete, bypass retention or change its settings', () => {
    expect(auditBucketViolations(a.statements).map(describeViolation)).toEqual([]);
  });

  it('lets only these stacks read or write the table across tenants', () => {
    const wide = crossTenantTableGrants(a.statements);
    expect(wide.length, 'the check should find the console and the pre-token trigger').toBeGreaterThan(0);
    const outside = wide.filter((s) => !CROSS_TENANT_TABLE_STACKS.includes(s.stack));
    expect(outside.map(describeStatement), 'A new cross-tenant grant needs review: ask P4 (contracts/CHANGE_REQUESTS/P4-<n>.md) to add the stack to CROSS_TENANT_TABLE_STACKS').toEqual([]);
  });

  it('lets only these stacks hold tenant bucket paths that span tenants', () => {
    const wide = crossTenantBucketGrants(a.statements);
    expect(wide.length).toBeGreaterThan(0);
    const outside = wide.filter((s) => !CROSS_TENANT_BUCKET_STACKS.includes(s.stack));
    expect(outside.map(describeStatement), 'A new cross-tenant bucket grant needs review: ask P4 (contracts/CHANGE_REQUESTS/P4-<n>.md)').toEqual([]);
  });

  it('lets only the tool API assume TenantDataRole, because whoever can assume it chooses the tenant', () => {
    const assumers = tenantRoleAssumers(a.statements);
    expect(assumers.length).toBeGreaterThan(0);
    const outside = assumers.filter((s) => !TENANT_ROLE_ASSUMER_STACKS.includes(s.stack));
    expect(outside.map(describeStatement)).toEqual([]);
    // Always together: assuming without the session-tag permission would be useless, and a lone TagSession is odd.
    for (const s of assumers) expect(s.actions.sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
  });

  it('lets no principal change IAM, which is how a role could be widened or the trust rewritten', () => {
    expect(iamWriteGrants(a.statements).map(describeStatement)).toEqual([]);
  });

  it('has no resource policy that allows everyone in without a condition', () => {
    expect(publicAllows(a.statements).map(describeStatement)).toEqual([]);
  });

  it('never uses NotAction or NotResource in an Allow, which no rule here can reason about', () => {
    const bad = a.statements.filter((s) => s.effect === 'Allow' && (s.notAction || s.notResource));
    expect(bad.map(describeStatement)).toEqual([]);
  });
});
