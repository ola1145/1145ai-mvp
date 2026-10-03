import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { AuthStack } from './auth-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { auth: AuthStack; events: EventsStack }

export interface OnSubscribeOptions {
  namespace: string;
  /** The only channel name allowed under /<namespace>/<id>/<suffix> (or /<namespace>/<suffix> for group-gated). */
  suffix: string;
  /** Cognito claim whose value must equal the <id> path segment (tenants: custom:tenant_id, owners: sub). */
  claim?: string;
  /** Cognito group the caller must be in (for namespaces with no <id> segment, e.g. /ops/fleet). */
  group?: string;
}

/**
 * AppSync onSubscribe handler (APPSYNC_JS). Deny by default: the path must be exactly the expected shape (so wildcard
 * subscriptions like /tenants/* or /tenants/<tid>/* are refused), and the identity must own the id segment.
 * The id comes only from the verified Cognito token claims, never from the client's request. ADR-0003.
 */
export function onSubscribeCode(o: OnSubscribeOptions): string {
  const ns = JSON.stringify(o.namespace);
  const suffix = JSON.stringify(o.suffix);
  if (o.group) {
    return `
import { util } from '@aws-appsync/utils';
export function onSubscribe(ctx) {
  const claims = ctx.identity && ctx.identity.claims ? ctx.identity.claims : null;
  const seg = ctx.info.channel.path.split('/');
  if (!claims || seg.length !== 3 || seg[0] !== '' || seg[1] !== ${ns} || seg[2] !== ${suffix}) { util.unauthorized(); }
  const groups = claims['cognito:groups'];
  if (!groups || !groups.includes(${JSON.stringify(o.group)})) { util.unauthorized(); }
}`;
  }
  return `
import { util } from '@aws-appsync/utils';
export function onSubscribe(ctx) {
  const claims = ctx.identity && ctx.identity.claims ? ctx.identity.claims : null;
  const seg = ctx.info.channel.path.split('/');
  if (!claims || seg.length !== 4 || seg[0] !== '' || seg[1] !== ${ns} || seg[3] !== ${suffix}) { util.unauthorized(); }
  const v = claims[${JSON.stringify(o.claim)}];
  if (!v || seg[2] !== v) { util.unauthorized(); }
}`;
}

/** AppSync Events for the live dashboard and owner chat replies (owner: P6). */
export class RealtimeStack extends Stack {
  readonly live: appsync.EventApi;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const U = appsync.AppSyncAuthorizationType;
    // Clients (Cognito) only subscribe; only the publisher Lambda (IAM) publishes. No client can publish to any channel.
    this.live = new appsync.EventApi(this, 'Live', {
      apiName: `${id}-live`,
      authorizationConfig: {
        authProviders: [{ authorizationType: U.USER_POOL, cognitoConfig: { userPool: props.auth.userPool } }, { authorizationType: U.IAM }],
        connectionAuthModeTypes: [U.USER_POOL],
        defaultPublishAuthModeTypes: [U.IAM],
        defaultSubscribeAuthModeTypes: [U.USER_POOL],
      },
    });
    const authorizationConfig = { publishAuthModeTypes: [U.IAM], subscribeAuthModeTypes: [U.USER_POOL] };
    const code = (o: OnSubscribeOptions) => appsync.Code.fromInline(onSubscribeCode(o));
    this.live.addChannelNamespace('tenants', { authorizationConfig, code: code({ namespace: 'tenants', suffix: 'live', claim: 'custom:tenant_id' }) });
    this.live.addChannelNamespace('owners', { authorizationConfig, code: code({ namespace: 'owners', suffix: 'chat', claim: 'sub' }) });
    this.live.addChannelNamespace('ops', { authorizationConfig, code: code({ namespace: 'ops', suffix: 'fleet', group: 'ops' }) });

    const publisher = nodeFn(this, 'Publisher', 'services/live-publisher/src/publish.ts', { env: { EVENTS_HTTP_DOMAIN: this.live.httpDns } });
    // Publish only, and only on our three namespaces. The publisher can never subscribe or connect.
    for (const ns of ['tenants', 'owners', 'ops']) {
      this.live.grant(publisher, appsync.AppSyncEventResource.ofChannelNamespace(ns), 'appsync:EventPublish');
    }
    const dlq = new sqs.Queue(this, 'PublisherDlq', { retentionPeriod: Duration.days(14), enforceSSL: true });
    new events.Rule(this, 'ToLive', {
      eventBus: props.events.bus,
      eventPattern: { detailType: ['call.started', 'call.ended', 'booking.created', 'booking.updated', 'booking.cancelled', 'message.taken', 'handoff.requested', 'onboarding.status', 'conversation.message', 'tenant.state_changed'] },
      targets: [new targets.LambdaFunction(publisher, { retryAttempts: 2, deadLetterQueue: dlq })],
    });
  }
}
