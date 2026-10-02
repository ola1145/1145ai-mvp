import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** ADR-0003: one table, tenant isolation enforced by IAM ABAC on dynamodb:LeadingKeys. */
export class DataStack extends Stack {
  readonly table: ddb.TableV2;
  readonly tenantBucket: s3.Bucket;
  readonly auditBucket: s3.Bucket;
  readonly tenantDataRole: iam.Role;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const key = new kms.Key(this, 'DataKey', { enableKeyRotation: true });

    this.table = new ddb.TableV2(this, 'Table', {
      tableName: `${id}-t1145`,
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      globalSecondaryIndexes: [{ indexName: 'GSI1', partitionKey: { name: 'GSI1PK', type: ddb.AttributeType.STRING }, sortKey: { name: 'GSI1SK', type: ddb.AttributeType.STRING } }],
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: ddb.TableEncryptionV2.customerManagedKey(key),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // tenants/<tid>/{kb,transcripts,exports}/...
    this.tenantBucket = new s3.Bucket(this, 'TenantBucket', {
      encryption: s3.BucketEncryption.KMS, encryptionKey: key, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
      lifecycleRules: [{ prefix: 'tenants/', tagFilters: { kind: 'transcript' }, expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.auditBucket = new s3.Bucket(this, 'AuditBucket', {
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(Duration.days(365)),
      encryption: s3.BucketEncryption.S3_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Assumed by the tool API with session tag tenant_id (trust allows sts:TagSession). Callers also need an identity policy (ApiStack).
    this.tenantDataRole = new iam.Role(this, 'TenantDataRole', { assumedBy: new iam.AccountRootPrincipal().withSessionTags(), maxSessionDuration: Duration.hours(1) });
    this.tenantDataRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
      resources: [this.table.tableArn, `${this.table.tableArn}/index/GSI1`],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenant_id}', 'TENANT#${aws:PrincipalTag/tenant_id}#*'] } },
    }));
    this.tenantDataRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`${this.tenantBucket.bucketArn}/tenants/\${aws:PrincipalTag/tenant_id}/*`],
    }));
    key.grantEncryptDecrypt(this.tenantDataRole);
  }

  /** Route items only (NUMBER#, IDENTITY#, ENGINEAGENT#, SIGNUP#, REFERRAL#). For resolvers and webhook routers. */
  grantRouteRead(grantee: iam.IGrantable) {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [this.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['NUMBER#*', 'IDENTITY#*', 'ENGINEAGENT#*', 'SIGNUP#*', 'REFERRAL#*'] } },
    }));
  }
}
