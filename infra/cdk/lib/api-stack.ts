import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer, HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { bundlingProps, fromRoot } from './paths.js';
import type { EventsStack } from './events-stack.js';
import type { AuthStack } from './auth-stack.js';

interface Props extends StackProps { data: DataStack; events: EventsStack; auth: AuthStack }

/** Voice-path Lambda sizing. Lambda CPU scales with memory, and these handlers are short and latency-bound, so voice
 *  routes get more memory than the rest. These are starting points, NOT measured values: tune from the numbers in
 *  services/tool-api/bench/README.md (run in dev, with the ABAC role). */
const VOICE_MEMORY_MB = 1024;
const DEFAULT_MEMORY_MB = 512;
const VOICE_PROVISIONED_CONCURRENCY = 2;

/** Route table mirrors contracts/openapi/tenant-tools.yaml. voice=true -> provisioned concurrency (Add-9). Owner: T7. */
const ROUTES: Array<{ method: apigw.HttpMethod; path: string; handler: string; voice?: boolean; auth: 'token' | 'iam' }> = [
  { method: apigw.HttpMethod.POST, path: '/v1/tools/availability', handler: 'check-availability', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings', handler: 'create-booking', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings/{bookingId}/reschedule', handler: 'reschedule-booking', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings/{bookingId}/cancel', handler: 'cancel-booking', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/messages', handler: 'take-message', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/kb/search', handler: 'search-knowledge', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/caller/lookup', handler: 'lookup-caller', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/handoff', handler: 'request-handoff', voice: true, auth: 'token' },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/reports/summary', handler: 'admin-summary', auth: 'token' },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/bookings', handler: 'admin-list-bookings', auth: 'token' },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/conversations', handler: 'admin-list-conversations', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/admin/changes', handler: 'admin-propose-change', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/admin/changes/apply', handler: 'admin-apply-change', auth: 'token' },
  { method: apigw.HttpMethod.PUT, path: '/v1/admin/hours', handler: 'admin-update-hours', auth: 'token' },
  { method: apigw.HttpMethod.PATCH, path: '/v1/admin/services/{serviceId}', handler: 'admin-update-service', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/internal/resolve/number', handler: 'internal-resolve-number', voice: true, auth: 'iam' },
  { method: apigw.HttpMethod.POST, path: '/internal/resolve/widget', handler: 'internal-resolve-widget', voice: true, auth: 'iam' },
];

export class ApiStack extends Stack {
  readonly url: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const secret = new sm.Secret(this, 'ToolApiSecret', { description: 'tokenCurrent, tokenPrevious, engineSecret' });
    const api = new apigw.HttpApi(this, 'ToolApi', { apiName: `${id}-tools` });
    const iamAuth = new HttpIamAuthorizer();
    // Dashboard routes reuse the same Lambdas under /dash with the Cognito JWT authorizer (claims -> requireTenantContext).
    const jwtAuth = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${props.auth.userPool.userPoolId}`, {
      jwtAudience: [props.auth.userPoolClient.userPoolClientId],
    });

    for (const r of ROUTES) {
      const fn = new nodejs.NodejsFunction(this, `Fn-${r.handler}`, {
        ...bundlingProps, entry: fromRoot(`services/tool-api/src/handlers/${r.handler}.ts`),
        runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64, memorySize: r.voice ? VOICE_MEMORY_MB : DEFAULT_MEMORY_MB,
        timeout: Duration.seconds(r.voice ? 3 : 10),
        environment: {
          TABLE_NAME: props.data.table.tableName, TENANT_DATA_ROLE_ARN: props.data.tenantDataRole.roleArn,
          EVENT_BUS_NAME: props.events.bus.eventBusName, TOOL_API_SECRET_ARN: secret.secretArn,
        },
        bundling: { format: nodejs.OutputFormat.ESM, minify: true, sourceMap: true },
      });
      secret.grantRead(fn);
      props.events.bus.grantPutEventsTo(fn);
      props.data.grantRouteRead(fn);
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [props.data.tenantDataRole.roleArn] }));

      // Provisioned concurrency removes cold starts (and the first AssumeRole) from the voice path. Always in prod; in dev
      // only when benchmarking: `cdk synth -c voiceProvisioned=true`, so dev numbers can be compared warm vs. provisioned.
      const provision = r.voice && (this.node.tryGetContext('stage') === 'prod' || String(this.node.tryGetContext('voiceProvisioned')) === 'true');
      const target = provision
        ? new lambda.Alias(this, `Live-${r.handler}`, { aliasName: 'live', version: fn.currentVersion, provisionedConcurrentExecutions: VOICE_PROVISIONED_CONCURRENCY })
        : fn;
      const integration = new HttpLambdaIntegration(`Int-${r.handler}`, target);
      api.addRoutes({ path: r.path, methods: [r.method], integration, authorizer: r.auth === 'iam' ? iamAuth : undefined });
      if (r.path.startsWith('/v1/admin') || r.path.startsWith('/v1/tools/bookings') || r.path === '/v1/tools/availability') {
        api.addRoutes({ path: `/dash${r.path}`, methods: [r.method], integration, authorizer: jwtAuth });
      }
    }
    this.url = api.apiEndpoint;
    new CfnOutput(this, 'ToolApiUrl', { value: api.apiEndpoint });
  }
}
