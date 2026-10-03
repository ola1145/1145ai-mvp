import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/**
 * Owner notifications: Telegram, email (Resend), web push, urgent call. No SMS/WhatsApp in MVP (owner: C6).
 *
 * The secret `1145/notifications` is created and filled by ops (bot token, Resend key, VAPID pair, Telnyx key);
 * this stack only references it by name, so no secret value ever lives in code or in the template.
 */
export class NotificationsStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const secret = secretsmanager.Secret.fromSecretNameV2(this, 'NotifySecret', '1145/notifications');
    const fn = nodeFn(this, 'Dispatcher', 'services/notifications/src/dispatcher.ts', {
      timeoutSec: 30,
      env: { TABLE_NAME: props.data.table.tableName, NOTIFY_SECRET_ID: secret.secretName },
    });
    secret.grantRead(fn);

    // The dispatcher reads owner contact details and prefs, and writes dedupe claims, for the tenant named in the
    // bus envelope. It is a platform service, not a tenant role, so it gets table access but only for TENANT# keys:
    // it can never read route items (NUMBER#, IDENTITY#, SIGNUP#...).
    props.data.table.grantReadWriteData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:Scan'],
      resources: [props.data.table.tableArn, `${props.data.table.tableArn}/index/*`],
      conditions: { 'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
    }));

    // Events that still fail after the retries land here instead of vanishing.
    const dlq = new sqs.Queue(this, 'NotifyDlq', { retentionPeriod: Duration.days(14), enforceSSL: true });
    new events.Rule(this, 'OwnerWorthy', {
      eventBus: props.events.bus,
      eventPattern: { detailType: ['booking.created', 'booking.cancelled', 'message.taken', 'handoff.requested', 'usage.recorded', 'tenant.state_changed', 'tenant.provisioned'] },
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 2, maxEventAge: Duration.hours(1), deadLetterQueue: dlq })],
    });
  }
}
