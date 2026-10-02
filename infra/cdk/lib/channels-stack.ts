import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { AuthStack } from './auth-stack.js';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack; auth: AuthStack }

/**
 * Owner channels (web chat, Telegram) + customer web chat token + referral redirect (owner: C1).
 * WhatsApp is Phase 2 (ADR-0005): its webhook only deploys with -c enableWhatsApp=true.
 */
export class ChannelsStack extends Stack {
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

    const router = fn('RouterWorker', 'router-worker.ts', 120);
    router.addEventSource(new SqsEventSource(inbound, { batchSize: 5, reportBatchItemFailures: true }));
    props.data.grantRouteRead(router);
    // TODO(C1): bedrock-agentcore:InvokeAgentRuntime on both runtime ARNs (from SSM), AppSync publish for owner chat replies.

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
}
