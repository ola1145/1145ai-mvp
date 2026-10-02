import { Stack, type StackProps } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import type { AuthStack } from './auth-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { auth: AuthStack; events: EventsStack }

const ONLY_OWN = (segIndex: number, claim: string) => appsync.Code.fromInline(`
import { util } from '@aws-appsync/utils';
export function onSubscribe(ctx) {
  const v = ctx.identity && ctx.identity.claims ? ctx.identity.claims['${claim}'] : null;
  const seg = ctx.info.channel.path.split('/');
  if (!v || seg[${segIndex}] !== v) { util.unauthorized(); }
}`);

/** AppSync Events for the live dashboard and owner chat replies (owner: P6). */
export class RealtimeStack extends Stack {
  readonly live: appsync.EventApi;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const U = appsync.AppSyncAuthorizationType;
    this.live = new appsync.EventApi(this, 'Live', {
      apiName: `${id}-live`,
      authorizationConfig: {
        authProviders: [{ authorizationType: U.USER_POOL, cognitoConfig: { userPool: props.auth.userPool } }, { authorizationType: U.IAM }],
        connectionAuthModeTypes: [U.USER_POOL, U.IAM],
        defaultPublishAuthModeTypes: [U.IAM],
        defaultSubscribeAuthModeTypes: [U.USER_POOL],
      },
    });
    this.live.addChannelNamespace('tenants', { code: ONLY_OWN(2, 'custom:tenant_id') });
    this.live.addChannelNamespace('owners', { code: ONLY_OWN(2, 'sub') });
    this.live.addChannelNamespace('ops');

    const publisher = nodeFn(this, 'Publisher', 'services/live-publisher/src/publish.ts', { env: { EVENTS_HTTP_DOMAIN: this.live.httpDns } });
    this.live.grantPublish(publisher);
    new events.Rule(this, 'ToLive', {
      eventBus: props.events.bus,
      eventPattern: { detailType: ['call.started', 'call.ended', 'booking.created', 'booking.updated', 'booking.cancelled', 'message.taken', 'handoff.requested', 'onboarding.status', 'conversation.message'] },
      targets: [new targets.LambdaFunction(publisher)],
    });
  }
}
