import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as appsync from 'aws-cdk-lib/aws-appsync';
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
 * SEC-25: brakes on every public route of the Hooks API (threat model F1 to F10). HTTP API throttling is per route, not per
 * caller, so this is a floor that caps cost and noise when something floods a route; the per-caller limits live in the
 * handlers (webchat token: per IP and per widget key) and in the FIFO queue (one owner at a time). Routes added later,
 * WhatsApp included, inherit it. Tune from real traffic.
 */
export const HOOKS_THROTTLE = { rateLimit: 25, burstLimit: 50 } as const;

/** The only prefixes the public channel Lambdas may touch beyond what their job needs (ADR-0003): one family each. */
const WIDGET_ROUTES = 'WIDGET#*';
const RATE_LIMIT_COUNTERS = 'RATELIMIT#*';
const REFERRAL_ROUTES = 'REFERRAL#*';
const REFERRAL_CLICKS = 'REFCLICK#*';

/**
 * Owner channels (web chat, Telegram) + customer web chat token + referral redirect (owner: C1).
 * WhatsApp is Phase 2 (ADR-0005): its webhook only deploys with -c enableWhatsApp=true.
 */
export class ChannelsStack extends Stack {
  readonly router: lambda.IFunction;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const stage: string = this.node.tryGetContext('stage') ?? 'dev';
    // One handle on the runtime secret (what scripts/secrets/push.sh writes), shared by the router, the Telegram webhook and the web chat token.
    const runtimeSecretId = `1145/${stage}/runtime`;
    const runtimeSecret = sm.Secret.fromSecretNameV2(this, 'RuntimeSecret', runtimeSecretId);

    const dlq = new sqs.Queue(this, 'InboundDlq', { fifo: true, retentionPeriod: Duration.days(14) });
    const inbound = new sqs.Queue(this, 'Inbound', {
      fifo: true, contentBasedDeduplication: false, visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });
    const env = { QUEUE_URL: inbound.queueUrl, TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName };
    const fn = (name: string, file: string, opts: { timeoutSec?: number; env?: Record<string, string> } = {}) =>
      nodeFn(this, name, `services/channels/src/${file}`, { timeoutSec: opts.timeoutSec ?? 5, env: { ...env, ...opts.env } });

    // CR C2-1: the webhook checks X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET in the runtime secret and fails closed without it.
    const telegram = fn('TelegramWebhook', 'telegram-webhook.ts', { env: { RUNTIME_SECRET_ID: runtimeSecretId } });
    const ownerChat = fn('OwnerChat', 'owner-chat.ts');
    // CR C4-2: LiveKit credentials come from the runtime secret; the handler answers 503 without RUNTIME_SECRET_ID.
    const webchatToken = fn('WebchatToken', 'customer-webchat-token.ts', { env: { RUNTIME_SECRET_ID: runtimeSecretId } });
    // CR C5-1: the redirect target is fixed per stage. The handler accepts https on 1145.ai only and falls back to production otherwise.
    const referral = fn('ReferralRedirect', 'referral-redirect.ts', { env: { APP_START_URL: appStartUrl(stage) } });

    for (const f of [telegram, ownerChat]) inbound.grantSendMessages(f);
    runtimeSecret.grantRead(telegram);
    runtimeSecret.grantRead(webchatToken);
    this.grantWebchatToken(webchatToken, props.data);
    this.grantReferral(referral, props.data);

    this.router = this.buildRouter(inbound, runtimeSecret, stage, props);

    const jwt = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${props.auth.userPool.userPoolId}`, {
      jwtAudience: [props.auth.userPoolClient.userPoolClientId],
    });
    const hooks = new apigw.HttpApi(this, 'Hooks', {
      apiName: `${id}-hooks`,
      // CR C3-1: the owner app (browser, Authorization header) calls /v1/owner-chat/messages, so it sends a preflight. The same API serves
      // /v1/webchat/token to the widget on tenants' own sites (any origin, CR C4-2). Once CORS is configured here API Gateway answers the
      // preflight itself and ignores the CORS headers a Lambda returns, so the origin list has to allow the widget: any origin, no
      // credentials. Nothing is exposed by that: every owner route needs the Cognito bearer token, which a page on another site cannot read.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
    // SEC-25 (threat model F1, F3, F4, F10; CRs C3-1, C4-2, C5-1): stage-wide default for every route, which applies to routes added later too.
    (hooks.defaultStage?.node.defaultChild as apigw.CfnStage).defaultRouteSettings = {
      throttlingRateLimit: HOOKS_THROTTLE.rateLimit, throttlingBurstLimit: HOOKS_THROTTLE.burstLimit,
    };
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
   * Customer web chat token (public). Reads the widget route, writes only its rate-limit counters. Narrower than
   * DataStack.grantRouteRead, which also opens IDENTITY#, NUMBER# and SIGNUP# items this function never needs.
   * The table key is customer-managed, and counter writes need GenerateDataKey on top of Decrypt (CR C4-2).
   */
  private grantWebchatToken(webchatToken: lambda.IFunction, data: DataStack) {
    webchatToken.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [WIDGET_ROUTES] } },
    }));
    webchatToken.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RATE_LIMIT_COUNTERS] } },
    }));
    data.dataKey.grantEncryptDecrypt(webchatToken);
  }

  /**
   * Referral redirect (public). Reads the referral route, writes the click log under REFCLICK#<code> and nothing under TENANT#.
   * No Query and no TransactWriteItems: the handler uses single-item conditional puts, atomic adds and one marker delete (CR C5-1).
   */
  private grantReferral(referral: lambda.IFunction, data: DataStack) {
    referral.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [REFERRAL_ROUTES] } },
    }));
    referral.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [REFERRAL_CLICKS] } },
    }));
    data.dataKey.grantEncryptDecrypt(referral);
  }

  /**
   * The FIFO router: DynamoDB route reads, its own narrow writes (onboarding start, message dedup), AgentCore invoke on
   * both runtimes (ARNs published to SSM by A1), AppSync Events publish for owner web chat replies, runtime secrets.
   */
  private buildRouter(inbound: sqs.Queue, runtimeSecret: sm.ISecret, stage: string, props: Props) {
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

    // Writes the router itself needs: the IDENTITY route and ONBOARDING record it creates on a first message, the pending
    // identity binding it settles on the owner's YES / NO (ONBOARDING#<id>/BINDING, SEC-20), and per-message dedup claims.
    // Nothing under TENANT#.
    router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [props.data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['IDENTITY#*', 'ONBOARDING#*', 'MSGDEDUP#*'] } },
    }));
    // The table uses a customer-managed key, which the data role needs to read and write items.
    props.data.dataKey.grantEncryptDecrypt(router);

    router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [onboardingArn, `${onboardingArn}/*`, adminArn, `${adminArn}/*`],
    }));

    runtimeSecret.grantRead(router);

    // Replies on /owners/<sub>/chat only (contracts/realtime/channels.md). The router never publishes to /tenants or /ops.
    if (props.realtime) props.realtime.live.grant(router, appsync.AppSyncEventResource.ofChannelNamespace('owners'), 'appsync:EventPublish');
    else router.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appsync:EventPublish'],
      resources: [`arn:${this.partition}:appsync:${this.region}:${this.account}:apis/*/channelNamespace/owners`],
    }));
    return router;
  }
}

/** Where the redirect sends visitors: the web onboarding start page of this stage's owner app (CR C5-1). */
function appStartUrl(stage: string): string {
  return stage === 'prod' ? 'https://app.1145.ai/start' : `https://app.${stage}.1145.ai/start`;
}
