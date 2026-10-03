import { SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; stage: string }

/**
 * Cognito with Google sign-in, scopes openid/email/profile only (no Google verification needed). Owner: P5.
 *
 * The Google OAuth client id and secret are read at deploy time from the Secrets Manager secret
 * `ai1145/<stage>/google-oauth` (JSON keys `clientId`, `clientSecret`). The owner creates it; see services/auth/README.md.
 * Nothing secret is ever written into the template.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly google: cognito.UserPoolIdentityProviderGoogle;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { stage, data } = props;

    this.userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // tenant_id and role are written only by us (and re-asserted on every token by the pre-token trigger).
      customAttributes: { tenant_id: new cognito.StringAttribute({ mutable: true }), role: new cognito.StringAttribute({ mutable: true }) },
    });

    // Pre-token trigger: custom:tenant_id / custom:role / custom:state from the MEMBER# item (GSI1PK = MEMBER#<sub>).
    const preToken = nodeFn(this, 'PreToken', 'services/auth/src/pre-token.ts', { env: { TABLE_NAME: data.table.tableName } });
    preToken.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${data.table.tableArn}/index/GSI1`],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MEMBER#*'] } },
    }));
    preToken.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [data.table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TENANT#*'] } },
    }));
    if (data.table.encryptionKey) {
      preToken.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [data.table.encryptionKey.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      }));
    }
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, preToken);

    // Hosted UI domain per stage: ai1145-dev, ai1145-prod.
    this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix: `ai1145-${stage}` } });

    // Google as the only identity provider. Credentials come from Secrets Manager via a dynamic reference.
    const secretName = `ai1145/${stage}/google-oauth`;
    this.google = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      clientId: SecretValue.secretsManager(secretName, { jsonField: 'clientId' }).unsafeUnwrap(),
      clientSecretValue: SecretValue.secretsManager(secretName, { jsonField: 'clientSecret' }),
      scopes: ['openid', 'email', 'profile'],
      // Identity facts only. Never map anything onto custom:* attributes.
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    const appHost = stage === 'prod' ? 'app.1145.ai' : `app.${stage}.1145.ai`;
    this.userPoolClient = this.userPool.addClient('Web', {
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }).withCustomAttributes('tenant_id', 'role'),
      // Users can never write custom:tenant_id or custom:role from a client.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${appHost}/auth/callback`, 'http://localhost:3000/auth/callback'],
        logoutUrls: [`https://${appHost}/`, 'http://localhost:3000/'],
      },
    });
    this.userPoolClient.node.addDependency(this.google);
  }
}
