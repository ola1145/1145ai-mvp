import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** Same default as the other Bedrock callers (agents/, engines/livekit-agent, provisioning). Override with `-c analysisModelId=...`. */
const DEFAULT_ANALYSIS_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** Created and filled by ops (docs/API_KEYS.md); this stack only references it by name, like the notifications secret. */
const DEFAULT_STRIPE_SECRET_NAME = '1145/stripe';

/**
 * call.ended -> analysis, CRM, usage, Stripe usage, live events (owner: G3).
 *
 * Failure path: the Lambda retries a failed run twice (Lambda async invoke, which is how EventBridge calls it), and the
 * handler resumes from the step that failed, so a retry never counts usage twice. After the last retry the event lands
 * in `dlq` with the error and the original event under `requestPayload`. To replay one, invoke the function with that
 * payload or put the event back on the bus; a finished call is a no-op, so a replay is always safe. An alarm on `dlq`
 * is wired through ObservabilityProps.dlqs (see contracts/CHANGE_REQUESTS/G3-2.md).
 *
 * Access: this is a platform Lambda, not a tenant role, so it works across tenants and the tenant boundary is the
 * tenant id on the bus envelope (checked in the handler). IAM limits what a bug could reach: table items under
 * TENANT# keys only, UpdateItem on NUMBER# route items (G2 flips a route to over_cap), transcripts read-only.
 */
export class PostCallStack extends Stack {
  /** Events that still failed after the retries. Page on any visible message. */
  readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { table, tenantBucket, dataKey } = props.data;
    const stripeSecretName = String(this.node.tryGetContext('stripeSecretName') ?? DEFAULT_STRIPE_SECRET_NAME);
    const modelId = String(this.node.tryGetContext('analysisModelId') ?? DEFAULT_ANALYSIS_MODEL_ID);

    const fn = nodeFn(this, 'PostCall', 'services/post-call/src/deps.ts', {
      timeoutSec: 60,
      memory: 512,
      env: {
        TABLE_NAME: table.tableName,
        EVENT_BUS_NAME: props.events.bus.eventBusName,
        TENANT_BUCKET: tenantBucket.bucketName,
        ANALYSIS_MODEL_ID: modelId,
        STRIPE_SECRET_ID: stripeSecretName,
      },
    });

    props.events.bus.grantPutEventsTo(fn);

    // Table: named actions, and only these key families. Scan and delete are not granted.
    // - TENANT#<tid>: the call ledger, conversation, customer, usage counter and profile; GSI1 for customer-by-phone.
    // - NUMBER#<e164>: G2 flips the route state to over_cap at the cap. UpdateItem only, so it cannot read routes.
    // Never IDENTITY#, SIGNUP#, ENGINEAGENT# or REFERRAL#.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
      resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['NUMBER#*'] } },
    }));
    dataKey.grantEncryptDecrypt(fn);

    // Transcripts: read only, only under tenants/<tid>/transcripts/. No bucket listing, no writes.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [tenantBucket.arnForObjects('tenants/*/transcripts/*')] }));

    // Analysis: the one model family, in this account's inference profiles and the foundation models behind them.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/anthropic.claude-*`,
        `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*anthropic.claude-*`,
      ],
    }));

    secretsmanager.Secret.fromSecretNameV2(this, 'StripeSecret', stripeSecretName).grantRead(fn);

    this.dlq = new sqs.Queue(this, 'PostCallDlq', { retentionPeriod: Duration.days(14), enforceSSL: true });
    fn.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(6), onFailure: new destinations.SqsDestination(this.dlq) });

    new events.Rule(this, 'CallEnded', {
      eventBus: props.events.bus,
      // call.ended only: the events this Lambda publishes (usage.recorded, conversation.message) never trigger it.
      eventPattern: { detailType: ['call.ended'] },
      // Retries here cover EventBridge failing to hand the event to Lambda (throttling); failed runs are retried by the Lambda config above.
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 4, maxEventAge: Duration.hours(2), deadLetterQueue: this.dlq })],
    });
  }
}
