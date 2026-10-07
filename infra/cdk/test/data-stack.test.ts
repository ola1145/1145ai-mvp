import { describe, expect, it } from 'vitest';
import { sharedApp } from './helpers/app.js';
import { statementsAttachedTo, type Statement } from './helpers/policy.js';
import { analyze } from './helpers/scope.js';
import { isLeadingKeyAction, TABLE, TENANT_BUCKET } from './helpers/rules.js';

/**
 * ADR-0003: tenant isolation is enforced by IAM, so the properties below are what a later PR must not weaken.
 * Everything runs against the real DataStack, synthesized in memory.
 */

const built = await sharedApp();
const a = analyze(built);
const data = built.templates.data.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const res = (id: string) => {
  const r = data.Resources[id];
  if (!r) throw new Error(`no resource ${id} in the data stack`);
  return r;
};
const service = (action: string) => action.split(':')[0]!.toLowerCase();

// The IAM policy variable that carries the tenant, exactly as written in the policies.
const TENANT_TAG = '${aws:PrincipalTag/tenant_id}';

describe('TenantDataRole', () => {
  const attached = statementsAttachedTo(built.templates.data, a.ids.tenantDataRole, a.sym, 'data');
  const trust = a.byStack('data').filter((s) => s.kind === 'trust' && s.source === a.ids.tenantDataRole);
  const ofService = (name: string): Statement[] => attached.filter((s) => s.actions.some((x) => service(x) === name));

  it('is assumed with session tags: the trust policy allows sts:TagSession next to sts:AssumeRole', () => {
    expect(trust.length).toBeGreaterThan(0);
    for (const s of trust) expect(s.effect).toBe('Allow');
    const both = trust.filter((s) => s.actions.includes('sts:AssumeRole') && s.actions.includes('sts:TagSession'));
    expect(both, JSON.stringify(trust)).toHaveLength(1);
    expect(trust.flatMap((s) => s.actions).every((x) => x === 'sts:AssumeRole' || x === 'sts:TagSession')).toBe(true);
  });

  it('trusts only this account (never "*"), and puts no condition on a caller that can pick the tag', () => {
    for (const s of trust) {
      expect(s.principal).toMatch(/^AWS=arn:PARTITION:iam::\d{12}:root$/);
      expect(s.resources).toEqual([]);
    }
  });

  it('only allows DynamoDB item actions that LeadingKeys can limit, never Scan or a wildcard', () => {
    const ddb = ofService('dynamodb');
    expect(ddb.length).toBeGreaterThan(0);
    for (const s of ddb) {
      expect(s.effect).toBe('Allow');
      expect(s.notAction).toBe(false);
      for (const action of s.actions) expect(isLeadingKeyAction(action), `${action} cannot be limited by LeadingKeys`).toBe(true);
    }
  });

  it('limits every DynamoDB action to LeadingKeys TENANT#${aws:PrincipalTag/tenant_id}', () => {
    for (const s of ofService('dynamodb')) {
      // ForAllValues, because a bare StringLike or ForAnyValue would let one matching key unlock a whole batch.
      expect(Object.keys(s.condition), JSON.stringify(s.condition)).toEqual(['ForAllValues:StringLike']);
      const patterns = s.condition['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
      expect(Object.keys(s.condition['ForAllValues:StringLike'] ?? {})).toEqual(['dynamodb:LeadingKeys']);
      expect(patterns).toContain(`TENANT#${TENANT_TAG}`);
      for (const p of patterns ?? []) {
        // The caller's own partition, or composite partitions that start with it. Never TENANT#* or a bare wildcard.
        expect(p === `TENANT#${TENANT_TAG}` || p.startsWith(`TENANT#${TENANT_TAG}#`), p).toBe(true);
      }
    }
  });

  it('covers only the table and its GSI1 index', () => {
    for (const s of ofService('dynamodb')) {
      expect(s.resources.length).toBeGreaterThan(0);
      for (const r of s.resources) expect(r === TABLE || r.startsWith(`${TABLE}/index/`), r).toBe(true);
    }
  });

  it('reaches S3 only under tenants/<its own tenant_id>/, with no bucket-level access', () => {
    const s3 = ofService('s3');
    expect(s3.length).toBeGreaterThan(0);
    for (const s of s3) {
      expect(s.effect).toBe('Allow');
      expect(s.condition).toEqual({});
      for (const action of s.actions) expect(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']).toContain(action);
      expect(s.resources).toEqual([`${TENANT_BUCKET}/tenants/${TENANT_TAG}/*`]);
    }
  });

  it('holds nothing but DynamoDB, S3 and the data key, and the key only', () => {
    for (const s of attached) expect(['dynamodb', 's3', 'kms'], JSON.stringify(s)).toContain(service(s.actions[0]!));
    const kms = ofService('kms');
    expect(kms.length).toBeGreaterThan(0);
    for (const s of kms) {
      expect(s.resources).toEqual(['DATA_KEY_ARN']);
      for (const action of s.actions) expect(['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey']).toContain(action);
    }
    expect(attached.every((s) => s.effect === 'Allow')).toBe(true);
  });

  it('has no managed or extra inline policies, and sessions of at most one hour', () => {
    const role = res(a.ids.tenantDataRole);
    expect(role.Type).toBe('AWS::IAM::Role');
    expect(role.Properties.ManagedPolicyArns ?? []).toEqual([]);
    expect(role.Properties.Policies ?? []).toEqual([]);
    expect(role.Properties.PermissionsBoundary).toBeUndefined();
    expect(role.Properties.MaxSessionDuration).toBeLessThanOrEqual(3600);
    // Exactly one policy is attached to the role, and it is in the data stack where the tests above read it.
    for (const [key, template] of Object.entries(built.templates)) {
      const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([, p]) => JSON.stringify((p.Properties as { Roles?: unknown }).Roles ?? []).includes(a.ids.tenantDataRole) || JSON.stringify((p.Properties as { Roles?: unknown }).Roles ?? []).includes('ExportsOutputFnGetAttTenantDataRole'));
      expect(policies.length, key).toBe(key === 'data' ? 1 : 0);
    }
  });
});

describe('audit bucket', () => {
  const audit = () => res(a.ids.auditBucket).Properties;

  it('has Object Lock with a default retention of at least a year', () => {
    expect(audit().ObjectLockEnabled).toBe(true);
    const cfg = audit().ObjectLockConfiguration;
    expect(cfg.ObjectLockEnabled).toBe('Enabled');
    const retention = cfg.Rule?.DefaultRetention;
    expect(retention, 'a default retention rule').toBeDefined();
    expect(['GOVERNANCE', 'COMPLIANCE']).toContain(retention.Mode);
    const days = retention.Days !== undefined ? retention.Days : retention.Years * 365;
    expect(days).toBeGreaterThanOrEqual(365);
  });

  it('blocks public access, enforces TLS and survives stack deletion', () => {
    expect(audit().PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(audit().AccessControl).toBeUndefined();
    expect(audit().WebsiteConfiguration).toBeUndefined();
    expect(audit().BucketEncryption.ServerSideEncryptionConfiguration).toHaveLength(1);
    expect(res(a.ids.auditBucket).DeletionPolicy).toBe('Retain');
    expect(res(a.ids.auditBucket).UpdateReplacePolicy).toBe('Retain');
    expect(tlsOnlyPolicies('AUDIT_BUCKET_ARN')).toHaveLength(1);
  });
});

describe('tenant bucket', () => {
  const tenant = () => res(a.ids.tenantBucket).Properties;

  it('blocks all public access with no ACL or website', () => {
    expect(tenant().PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(tenant().AccessControl).toBeUndefined();
    expect(tenant().WebsiteConfiguration).toBeUndefined();
    expect(tenant().CorsConfiguration).toBeUndefined();
  });

  it('enforces SSL: a bucket policy denies every request that is not over TLS, on the bucket and its objects', () => {
    expect(tlsOnlyPolicies('TENANT_BUCKET_ARN')).toHaveLength(1);
  });

  it('is encrypted with the data key and survives stack deletion', () => {
    const [rule] = tenant().BucketEncryption.ServerSideEncryptionConfiguration;
    expect(rule.ServerSideEncryptionByDefault.SSEAlgorithm).toBe('aws:kms');
    expect(JSON.stringify(rule.ServerSideEncryptionByDefault.KMSMasterKeyID)).toContain(a.ids.dataKey);
    expect(res(a.ids.tenantBucket).DeletionPolicy).toBe('Retain');
    expect(res(a.ids.tenantBucket).UpdateReplacePolicy).toBe('Retain');
  });
});

describe('every bucket in the app', () => {
  it('blocks public access and denies non-TLS requests, so a new bucket cannot slip in open', () => {
    let buckets = 0;
    for (const [key, template] of Object.entries(built.templates)) {
      const t = template.toJSON() as { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
      for (const [id, r] of Object.entries(t.Resources ?? {})) {
        if (r.Type !== 'AWS::S3::Bucket') continue;
        buckets++;
        expect(r.Properties?.PublicAccessBlockConfiguration, `${key}/${id}`).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
        expect(r.Properties?.AccessControl, `${key}/${id}`).toBeUndefined();
        const policies = Object.values(template.findResources('AWS::S3::BucketPolicy')).filter((p) => JSON.stringify((p.Properties as { Bucket: unknown }).Bucket).includes(`"${id}"`));
        expect(policies.length, `${key}/${id} needs a bucket policy that enforces TLS`).toBeGreaterThan(0);
        expect(JSON.stringify(policies), `${key}/${id}`).toContain('aws:SecureTransport');
      }
    }
    expect(buckets).toBeGreaterThanOrEqual(2);
  });
});

describe('table and key', () => {
  it('encrypts the table with the data key, keeps point-in-time recovery and deletion protection, and retains it', () => {
    const table = res(a.ids.table);
    expect(table.Type).toBe('AWS::DynamoDB::GlobalTable');
    expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: true, SSEType: 'KMS' });
    const [replica] = table.Properties.Replicas;
    expect(JSON.stringify(replica.SSESpecification.KMSMasterKeyId)).toContain(a.ids.dataKey);
    expect(replica.DeletionProtectionEnabled).toBe(true);
    expect(replica.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
  });

  it('rotates the data key and keeps it when the stack goes', () => {
    const key = res(a.ids.dataKey);
    expect(key.Properties.EnableKeyRotation).toBe(true);
    expect(key.DeletionPolicy).toBe('Retain');
  });
});

/** Bucket policy statements that deny every non-TLS request on the bucket ARN and all its objects. */
function tlsOnlyPolicies(bucket: string): Statement[] {
  return a.byStack('data').filter((s) => s.kind === 'resource' && s.effect === 'Deny'
    && s.actions.includes('s3:*') && s.principal === 'AWS=*'
    && JSON.stringify(s.condition) === JSON.stringify({ Bool: { 'aws:SecureTransport': ['false'] } })
    && s.resources.length === 2 && s.resources.includes(bucket) && s.resources.includes(`${bucket}/*`));
}
