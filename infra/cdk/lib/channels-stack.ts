import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { AuthStack } from './auth-stack.js';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';
import type { RealtimeStack } from './realtime-stack.js';

interface Props extends StackProps {
  data: DataStack; events: EventsStack; auth: AuthStack;
  /** Optional until bin/app.ts (P2) passes them; see contracts/CHANGE_REQUESTS/C1-2.md. Context fallbacks keep synth working. */
  realtime?: RealtimeStack;
  toolApiUrl?: string;
}

/**
 * Owner channels (web chat, Telegram) + customer web chat token + referral redirect (owner: C1).
 * WhatsApp is Phase 2 (ADR-0005): its webhook only deploys with -c enableWhatsApp=true.
 */
export class ChannelsStack extends Stack {
  readonly router: lambda.IFunction;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const dlq = new sqs.Queue(this, 'InboundDlq', { fifo: true, retentionPeriod: Duration.days(14) });
    const inbound = new sqs.Queue(this, 'Inbound', {
      fifo: true, contentBasedDeduplication: false, visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });
    const env = { QUEUE_URL: inbound.queueUrl, TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName };
    const fn = (name: string, file: string, timeoutSec = 5) => nodeFn(this, name, `services/channels/src/${file}`, { timeoutSec, env });

    const telegram = fn('TelegramWebhook', 'telegram-webhook.ts');
    const ownerChat = fn('OwnerChat', 'owner-chat.ts');
    const webchatToken = fn('WebchatToken', 'customer-webchat-token.ts');
    const referral = fn('ReferralRedirect', 'referral-redirect.ts');
    for (const f of [telegram, ownerChat]) inbound.grantSendMessages(f);
    for (const f of [webchatToken, referral]) props.data.grantRouteRead(f);

    this.router = this.buildRouter(inbound, props);

    const jwt = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${props.auth.userPool.userPoolId}`, {
      jwtAudience: [props.auth.userPoolClient.userPoolClientId],
    });
    const hooks = new apigw.HttpApi(this, 'Hooks', { apiName: `${id}-hooks` });
    hooks.addRoutes({ path: '/telegram', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('TgInt', telegram) });
    hooks.addRoutes({ path: '/v1/owner-chat/messages', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('OwnerChatInt', ownerChat), authorizer: jwt });
    hooks.addRoutes({ path: '/v1/webchat/token', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('WebchatInt', webchatToken) });
    hooks.addRoutes({ path: '/r/{code}', methods: [apigw.HttpMethod.GET], integration: new HttpLambdaIntegration('RefInt', referral) });

    if (this.node.tryGetContext('enableWhatsApp') === 'true') {
      const wa = fn('WhatsAppWebhook', 'whatsapp-webhook.ts');
      inbound.grantSendMessages(wa);
      hooks.addRoutes({ path: '/whatsapp', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('WaInt', wa) });
    }
    new CfnOutput(this, 'HooksUrl', { value: hooks.apiEndpoint });
  }

  /**
   * The FIFO router: DynamoDB route reads, its own narrow writes (onboarding start, message dedup), AgentCore invoke on
   * both runtimes (ARNs published to SSM by A1), AppSync Events publish for owner web chat replies, runtime secrets.
   */
  private buildRouter(inbound: sqs.Queue, props: Props) {
    const stage: string = this.node.tryGetContext('stage') ?? 'dev';
    const onboardingArn = ssm.StringParameter.valueForStringParameter(this, `/1145/${stage}/agentcore/onboarding-arn`);
    const adminArn = ssm.StringParameter.valueForStringParameter(this, `/1145/${stage}/agentcore/admin-arn`);
    const eventsDomain: string | undefined = props.realtime?.live.httpDns ?? this.node.tryGetContext('eventsHttpDomain');
    const toolApiUrl: string | undefined = props.toolApiUrl ?? this.node.tryGetContext('toolApiUrl');

    // Longest path: one agent call (hard stop 110 s) plus delivery. One record per invocation keeps that bound.
    const router = nodeFn(this, 'RouterWorker', 'services/channels/src/router-worker.ts', {
      timeoutSec: 150,
      env: {
        TABLE_NAME: props.data.table.tableName,
        RUNTIME_SECRET_ID: `1145/${stage}/runtime`,
        AGENT_ONBOARDING_ARN: onboardingArn,
        AGENT_ADMIN_ARN: adminArn,
        ...(eventsDomain ? { EVENTS_HTTP_DOMAIN: eventsDomain } : {}),
        ...(toolApiUrl ? { TOOL_API_URL: toolApiUrl } : {}),
      },
    });
    router.addEventSource(new SqsEventSource(inbound, { batchSize: 1, reportBatchItemFailures: true }));
    props.data.grantRouteRead(router);

    // Writes the router itself needs: the IDENTITY route and ONBOARDING record it creates on a first message, and
    // per-message dedup claims. Nothing under TENANT#.
    router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [props.data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['IDENTITY#*', 'ONBOARDING#*', 'MSGDEDUP#*'] } },
    }));
    // The table uses a customer-managed key, which the data role needs to read and write items.
    props.data.table.encryptionKey?.grantEncryptDecrypt(router);

    router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [onboardingArn, `${onboardingArn}/*`, adminArn, `${adminArn}/*`],
    }));

    sm.Secret.fromSecretNameV2(this, 'RuntimeSecret', `1145/${stage}/runtime`).grantRead(router);

    if (props.realtime) props.realtime.live.grantPublish(router);
    else router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appsync:EventPublish'],
      resources: [`arn:${this.partition}:appsync:${this.region}:${this.account}:apis/*/channelNamespace/owners`],
    }));
    return router;
  }
}
