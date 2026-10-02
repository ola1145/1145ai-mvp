import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import type { Construct } from 'constructs';

/** Event bus, Cognito (Google sign-in) and AppSync Events for the live dashboard (Change-8). */
export class EventsStack extends Stack {
  readonly bus: events.EventBus;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly live: appsync.EventApi;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: `${id}-1145` });
    this.bus.archive('Archive', { eventPattern: { source: [{ prefix: '1145.' }] as unknown as string[] }, retention: Duration.days(30) });

    this.userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false, // accounts are created by the signup callback after the chat-bound token is consumed
      signInAliases: { email: true },
      customAttributes: { tenant_id: new cognito.StringAttribute({ mutable: true }), role: new cognito.StringAttribute({ mutable: true }) },
    });
    // TODO(W1-10): UserPoolIdentityProviderGoogle (client secret from Secrets Manager), hosted domain, and a
    // pre-token-generation trigger that sets custom:tenant_id from MEMBER# items. Users can NOT write these attributes.
    this.userPoolClient = this.userPool.addClient('Web', {
      generateSecret: false,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }).withCustomAttributes('tenant_id', 'role'),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
    });

    this.live = new appsync.EventApi(this, 'Live', {
      apiName: `${id}-live`,
      authorizationConfig: {
        authProviders: [
          { authorizationType: appsync.AppSyncAuthorizationType.USER_POOL, cognitoConfig: { userPool: this.userPool } },
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL, appsync.AppSyncAuthorizationType.IAM],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL],
      },
    });
    // Owners may subscribe only to /tenants/<their tenant>/... (verify handler semantics in W1-10).
    this.live.addChannelNamespace('tenants', {
      code: appsync.Code.fromInline(`
import { util } from '@aws-appsync/utils';
export function onSubscribe(ctx) {
  const tid = ctx.identity && ctx.identity.claims ? ctx.identity.claims['custom:tenant_id'] : null;
  const seg = ctx.info.channel.path.split('/');
  if (!tid || seg[2] !== tid) { util.unauthorized(); }
}`),
    });
    this.live.addChannelNamespace('ops');
  }
}
