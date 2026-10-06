import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** Stripe webhook, admin console API (IAM-auth for 1145 staff), audit writes (owner: H2). */
export class ControlPlaneStack extends Stack {
  readonly consoleInvokePolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { table, tenantBucket, auditBucket } = props.data;
    const env = {
      TABLE_NAME: table.tableName,
      EVENT_BUS_NAME: props.events.bus.eventBusName,
      AUDIT_BUCKET: auditBucket.bucketName,
      TENANT_BUCKET: tenantBucket.bucketName,
    };
    const stripe = nodeFn(this, 'StripeWebhook', 'services/control-plane/src/stripe-webhook.ts', { env });
    // Export and delete walk a whole tenant partition, so the console gets the API Gateway maximum.
    const consoleApi = nodeFn(this, 'ConsoleApi', 'services/control-plane/src/console/api.ts', { env, timeoutSec: 29, memory: 512 });
    for (const f of [stripe, consoleApi]) { auditBucket.grantPut(f); props.events.bus.grantPutEventsTo(f); }

    // Console data access. Named actions only (no dynamodb:*), limited to the key families the console touches.
    // Scan cannot carry a LeadingKeys condition, so it is its own statement: it only feeds the tenant list
    // (PROFILE rows) until the tenant index in contracts/CHANGE_REQUESTS/H2-2.md exists.
    consoleApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'],
      resources: [table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*', 'TEMPLATE#*', 'NUMBER#*', 'ENGINEAGENT#*'] } },
    }));
    consoleApi.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [table.tableArn] }));
    table.encryptionKey?.grantEncryptDecrypt(consoleApi);
    // Transcripts are read, exports written and read, and tenant folders emptied on delete: tenants/* only.
    tenantBucket.grantReadWrite(consoleApi, 'tenants/*');

    const corsOrigins = String(this.node.tryGetContext('consoleOrigins') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const api = new apigw.HttpApi(this, 'Control', {
      apiName: `${id}-control`,
      ...(corsOrigins.length
        ? {
            corsPreflight: {
              allowOrigins: corsOrigins,
              allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT],
              allowHeaders: ['authorization', 'content-type', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'],
            },
          }
        : {}),
    });
    // Brakes for both routes: the webhook is retried by Stripe, the console is a handful of staff.
    (api.defaultStage?.node.defaultChild as apigw.CfnStage).defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };
    api.addRoutes({ path: '/stripe/webhook', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('StripeInt', stripe) });
    api.addRoutes({
      path: '/console/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('ConsoleInt', consoleApi),
      authorizer: new HttpIamAuthorizer(),
    });

    // Attach this to the IAM role or group that 1145 staff sign in with. Without it nobody can call the console.
    this.consoleInvokePolicy = new iam.ManagedPolicy(this, 'ConsoleInvoke', {
      description: 'Lets the holder call the 1145 admin console API (SigV4).',
      statements: [new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: [api.arnForExecuteApi('*', '/console/*')] })],
    });

    new CfnOutput(this, 'ConsoleApiUrl', { value: `${api.apiEndpoint}/console` });
    new CfnOutput(this, 'ConsoleInvokePolicyArn', { value: this.consoleInvokePolicy.managedPolicyArn });
  }
}
