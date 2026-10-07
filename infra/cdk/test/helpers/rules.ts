import type { Statement } from './policy.js';

/**
 * The isolation rules (ADR-0003), written as plain functions over flattened statements so the same code runs on the
 * real stacks and on deliberately bad statements (the "negative controls" in policy-rules.test.ts).
 */

export const TABLE = 'TABLE_ARN';
export const TENANT_BUCKET = 'TENANT_BUCKET_ARN';
export const AUDIT_BUCKET = 'AUDIT_BUCKET_ARN';
export const TENANT_ROLE = 'TENANT_ROLE_ARN';

const lc = (s: string) => s.toLowerCase();

export interface Violation {
  stack: string;
  source: string;
  rule: string;
  actions: string[];
  resources: string[];
  why: string;
}

const violation = (st: Statement, rule: string, actions: string[], why: string): Violation =>
  ({ stack: st.stack, source: st.source, rule, actions, resources: st.resources, why });

/** True for the any-action wildcards: `*` and `<service>:*`. */
const isAllActions = (a: string, service: string) => a === '*' || lc(a) === `${service}:*`;

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------------------------

/**
 * Actions where IAM puts the partition key in `dynamodb:LeadingKeys`, so a LeadingKeys condition really limits them.
 * For every other action the key is absent, and `ForAllValues` is TRUE when the key is absent. A `ForAllValues`
 * LeadingKeys condition on Scan (and friends) therefore limits nothing.
 */
export const LEADING_KEY_ACTIONS = new Set(['getitem', 'batchgetitem', 'query', 'putitem', 'updateitem', 'deleteitem', 'batchwriteitem', 'conditioncheckitem'].map((a) => `dynamodb:${a}`));

export const isLeadingKeyAction = (a: string) => LEADING_KEY_ACTIONS.has(a.toLowerCase());

/** Reads table settings only, never items. Fine without a condition. */
const isDescribe = (a: string) => /^dynamodb:describe[a-z]*$/.test(lc(a));

export function coversTable(resource: string): boolean {
  return resource === '*' || resource === TABLE || resource.startsWith(`${TABLE}/`)
    || /^arn:[^:]*:dynamodb:[^:]*:[^:]*:table\/(\*|[^/]*\*)/.test(resource);
}

/** The LeadingKeys patterns of a statement, if it is limited by a proper `ForAllValues` condition; otherwise undefined. */
export function leadingKeyPatterns(st: Statement): string[] | undefined {
  for (const op of ['ForAllValues:StringLike', 'ForAllValues:StringEquals']) {
    const patterns = st.condition[op]?.['dynamodb:LeadingKeys'];
    if (patterns?.length) return patterns;
  }
  return undefined;
}

/** A pattern must start with a literal key family (`TENANT#`, `NUMBER#`...), never a bare wildcard. */
const isFamilyPattern = (p: string) => /^[A-Z][A-Z0-9_]*#/.test(p);

/** Allow statements that let a principal reach the table in a way LeadingKeys does not (or does not properly) limit. */
export function dynamoViolations(statements: Statement[]): Violation[] {
  const out: Violation[] = [];
  for (const st of statements) {
    if (st.effect !== 'Allow' || st.kind === 'trust') continue;
    const touchesTable = st.notResource || st.resources.some(coversTable);
    if (!touchesTable) continue;
    if (st.notAction) { out.push(violation(st, 'dynamodb-not-action', [], 'Allow with NotAction grants everything except a list, so LeadingKeys cannot be checked')); continue; }
    const actions = st.actions.filter((a) => lc(a).startsWith('dynamodb:') || a === '*');
    if (!actions.length) continue;

    const patterns = leadingKeyPatterns(st);
    const goodPatterns = !!patterns && patterns.every(isFamilyPattern);
    const unlimited: string[] = [];
    const cannotBeLimited: string[] = [];
    for (const a of actions) {
      if (isDescribe(a)) continue;
      if (isLeadingKeyAction(a)) { if (!goodPatterns) unlimited.push(a); }
      else cannotBeLimited.push(a);
    }
    if (cannotBeLimited.length) {
      out.push(violation(st, 'dynamodb-unlimitable', cannotBeLimited,
        'LeadingKeys is not set for these actions (or they are wildcards), so no condition can restrict them to a partition'));
    }
    if (unlimited.length) {
      out.push(violation(st, 'dynamodb-no-leading-keys', unlimited,
        patterns ? `LeadingKeys patterns must start with a key family like TENANT#, got ${JSON.stringify(patterns)}` : 'item access needs a ForAllValues:StringLike|StringEquals condition on dynamodb:LeadingKeys'));
    }
  }
  return out;
}

/** Statements that hold DynamoDB access across more than one tenant (a TENANT#<wildcard> pattern, or no usable limit). */
export function crossTenantTableGrants(statements: Statement[]): Statement[] {
  const bad = new Set(dynamoViolations(statements).map((v) => `${v.stack}/${v.source}/${v.resources.join('|')}`));
  return statements.filter((st) => {
    if (st.effect !== 'Allow' || st.kind === 'trust') return false;
    if (!st.notResource && !st.resources.some(coversTable)) return false;
    if (!st.actions.some((a) => lc(a).startsWith('dynamodb:') || a === '*') && !st.notAction) return false;
    if (st.actions.every(isDescribe)) return false;
    const wide = leadingKeyPatterns(st)?.some((p) => /^TENANT#[*?]/.test(p)) ?? false;
    return wide || bad.has(`${st.stack}/${st.source}/${st.resources.join('|')}`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------------------------------------------

const coversWildcardBucket = (r: string) => r === '*' || /^arn:[^:]*:s3:::(\*|[^/]*\*)/.test(r);
/** List and read-only bucket settings: allowed on the bucket itself (the lists show key names only). */
const BUCKET_READ_ONLY = /^s3:(list[a-z]*\*?|getbucket[a-z]*\*?)$/;
/** Actions that only mean something on an object ARN, so they do nothing on the bucket ARN itself. */
const OBJECT_ONLY = /object|abort|multipart/;
const hasPrefixCondition = (st: Statement) => Object.values(st.condition).some((keys) => Object.keys(keys).some((k) => lc(k) === 's3:prefix'));

/** Allow statements that open the tenant bucket wider than `tenants/...` object paths. */
export function tenantBucketViolations(statements: Statement[]): Violation[] {
  const out: Violation[] = [];
  for (const st of statements) {
    if (st.effect !== 'Allow' || st.kind === 'trust') continue;
    const covering = st.resources.filter((r) => r === TENANT_BUCKET || r.startsWith(`${TENANT_BUCKET}/`) || coversWildcardBucket(r));
    if (!covering.length && !st.notResource) continue;
    if (st.notAction) { if (covering.length || st.notResource) out.push(violation(st, 's3-not-action', [], 'Allow with NotAction on the tenant bucket cannot be checked')); continue; }
    const actions = st.actions.filter((a) => lc(a).startsWith('s3:') || a === '*');
    if (!actions.length) continue;
    // Listing buckets is account-wide and shows no objects.
    if (actions.every((a) => lc(a) === 's3:listallmybuckets')) continue;

    const why: string[] = [];
    if (actions.some((a) => isAllActions(a, 's3'))) why.push('s3:* (or *) on the tenant bucket');
    if (st.notResource) why.push('NotResource');
    for (const r of covering) {
      if (coversWildcardBucket(r)) { why.push(`${r} covers every bucket`); continue; }
      if (r === TENANT_BUCKET) {
        const risky = actions.filter((a) => !BUCKET_READ_ONLY.test(lc(a)) && !OBJECT_ONLY.test(lc(a)));
        if (risky.length && !hasPrefixCondition(st)) why.push(`bucket-level ${risky.join(', ')}`);
      } else if (!r.startsWith(`${TENANT_BUCKET}/tenants/`) && !hasPrefixCondition(st)) {
        why.push(`${r} is outside tenants/`);
      }
    }
    if (why.length) out.push(violation(st, 's3-tenant-bucket', actions, why.join('; ')));
  }
  return out;
}

// Statements that let a principal hold an object path that spans tenants: tenants/<wildcard> or the whole bucket.
export function crossTenantBucketGrants(statements: Statement[]): Statement[] {
  return statements.filter((st) => st.effect === 'Allow' && st.kind !== 'trust'
    && st.actions.some((a) => lc(a).startsWith('s3:') || a === '*')
    && st.resources.some((r) => (r.startsWith(`${TENANT_BUCKET}/tenants/`) && /^\/tenants\/[*?]/.test(r.slice(TENANT_BUCKET.length))) || r === `${TENANT_BUCKET}/*`));
}

/** Nobody may delete from, unlock or reconfigure the audit bucket, and nobody gets it through a wildcard. */
const AUDIT_FORBIDDEN = /^s3:(\*|delete|bypassgovernanceretention|putbucket|putlifecycle|putencryption|putobjectlockconfiguration|putreplication|put\*)/;
export function auditBucketViolations(statements: Statement[]): Violation[] {
  const out: Violation[] = [];
  for (const st of statements) {
    if (st.effect !== 'Allow' || st.kind === 'trust') continue;
    if (!st.notResource && !st.resources.some((r) => r === AUDIT_BUCKET || r.startsWith(`${AUDIT_BUCKET}/`) || coversWildcardBucket(r))) continue;
    if (st.notAction) { out.push(violation(st, 's3-audit-not-action', [], 'Allow with NotAction can include delete and bypass')); continue; }
    const bad = st.actions.filter((a) => a === '*' || AUDIT_FORBIDDEN.test(lc(a)));
    if (bad.length) out.push(violation(st, 's3-audit-bucket', bad, 'the audit bucket is append-only: no delete, bypass or bucket settings'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Who can become a tenant
// ---------------------------------------------------------------------------------------------------------------

/** Allow statements that let a principal assume TenantDataRole, which means choosing the tenant_id session tag. */
export function tenantRoleAssumers(statements: Statement[]): Statement[] {
  return statements.filter((st) => st.effect === 'Allow' && st.kind === 'identity'
    && (st.notAction || st.actions.some((a) => ['sts:assumerole', 'sts:tagsession', 'sts:*', '*'].includes(lc(a))))
    && (st.notResource || st.resources.some((r) => r === TENANT_ROLE || r === '*' || /^arn:[^:]*:iam::[^:]*:role\/(\*|[^/]*\*)/.test(r))));
}

/** Actions that could rewrite who may assume the role, or what it may do. */
const IAM_WRITE = /^iam:(\*|put|create|update|attach|detach|delete|passrole|addroleto|setdefault|tag|untag)/;
export function iamWriteGrants(statements: Statement[]): Statement[] {
  return statements.filter((st) => st.effect === 'Allow' && st.kind === 'identity'
    && (st.notAction || st.actions.some((a) => a === '*' || IAM_WRITE.test(lc(a)))));
}

/** Resource policies that let anyone (Principal "*") in without a condition. */
export function publicAllows(statements: Statement[]): Statement[] {
  return statements.filter((st) => st.effect === 'Allow' && st.kind === 'resource'
    && (st.principal === '*' || /(^|;)AWS=\*(;|$)/.test(st.principal))
    && Object.keys(st.condition).length === 0);
}
