import { Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; stage: string }

/**
 * Cognito with Google sign-in, scopes openid/email/profile only (no Google verification needed). Owner: P5.
 * TODO(P5): UserPoolIdentityProviderGoogle with the client secret from Secrets Manager; callback URLs per stage.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    this.userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      customAttributes: { tenant_id: new cognito.StringAttribute({ mutable: true }), role: new cognito.StringAttribute({ mutable: true }) },
    });
    const preToken = nodeFn(this, 'PreToken', 'services/auth/src/pre-token.ts', { env: { TABLE_NAME: props.data.table.tableName } });
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, preToken);
    this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: `ai1145-${props.stage}` } });
    this.userPoolClient = this.userPool.addClient('Web', {
      generateSecret: false,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }).withCustomAttributes('tenant_id', 'role'),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://app.${props.stage === 'prod' ? '' : props.stage + '.'}1145.ai/auth/callback`, 'http://localhost:3000/auth/callback'] },
    });
  }
}
