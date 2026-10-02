import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { bundlingProps, fromRoot } from './paths.js';
import type { EventsStack } from './events-stack.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** Add-2: webhooks verify + enqueue + 200; a FIFO queue keeps per-user order and drops Meta/Telegram retries. */
export class ChannelsStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const dlq = new sqs.Queue(this, 'InboundDlq', { fifo: true, retentionPeriod: Duration.days(14) });
    const inbound = new sqs.Queue(this, 'Inbound', {
      fifo: true, contentBasedDeduplication: false, visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const fn = (name: string, entry: string, timeout = 5) => new nodejs.NodejsFunction(this, name, {
      ...bundlingProps, entry: fromRoot(`services/channels/src/${entry}`), runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(timeout), memorySize: 256,
      environment: { QUEUE_URL: inbound.queueUrl, TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName },
      bundling: { format: nodejs.OutputFormat.ESM, minify: true },
    });

    const wa = fn('WhatsAppWebhook', 'whatsapp-webhook.ts');
    const tg = fn('TelegramWebhook', 'telegram-webhook.ts');
    inbound.grantSendMessages(wa);
    inbound.grantSendMessages(tg);

    const router = fn('RouterWorker', 'router-worker.ts', 120);
    router.addEventSource(new SqsEventSource(inbound, { batchSize: 5, reportBatchItemFailures: true }));
    props.data.grantRouteRead(router);
    // TODO(W1-12): grant bedrock-agentcore:InvokeAgentRuntime on the two runtime ARNs; secrets for Meta/Telegram send.

    const hooks = new apigw.HttpApi(this, 'Hooks', { apiName: `${id}-hooks` });
    hooks.addRoutes({ path: '/whatsapp', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('WaInt', wa) });
    hooks.addRoutes({ path: '/telegram', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('TgInt', tg) });
    new CfnOutput(this, 'HooksUrl', { value: hooks.apiEndpoint });
  }
}
