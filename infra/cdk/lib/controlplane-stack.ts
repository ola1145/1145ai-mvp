import { Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** Stripe webhook, admin console API (IAM-auth for 1145 staff), audit writes (owner: H2). */
export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const env = { TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName, AUDIT_BUCKET: props.data.auditBucket.bucketName };
    const stripe = nodeFn(this, 'StripeWebhook', 'services/control-plane/src/stripe-webhook.ts', { env });
    const consoleApi = nodeFn(this, 'ConsoleApi', 'services/control-plane/src/console/api.ts', { env, timeoutSec: 29 });
    for (const f of [stripe, consoleApi]) { props.data.auditBucket.grantPut(f); props.events.bus.grantPutEventsTo(f); }
    const api = new apigw.HttpApi(this, 'Control', { apiName: `${id}-control` });
    api.addRoutes({ path: '/stripe/webhook', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('StripeInt', stripe) });
    api.addRoutes({ path: '/console/{proxy+}', methods: [apigw.HttpMethod.ANY], integration: new HttpLambdaIntegration('ConsoleInt', consoleApi), authorizer: new HttpIamAuthorizer() });
  }
}
