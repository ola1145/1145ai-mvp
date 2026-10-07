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

/** Floor on the whole HTTP API, per stage (SEC-11, SEC-25): requests per second and burst, across all routes and callers.
 *  The per-tenant token buckets (lib/rate-limit.ts) sit behind it. Generous for MVP traffic (a call makes a tool call every
 *  few seconds); tune with `-c toolApiThrottleRps=...` and `-c toolApiThrottleBurst=...`. */
const DEFAULT_THROTTLE_RPS = 200;
const DEFAULT_THROTTLE_BURST = 400;

/** Titan Text Embeddings V2: what knowledge search embeds the question with (deps.ts uses the same id). */
const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

const positive = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/** Route item families a function may read (ADR-0003: route items only, and only the ones that function needs). */
const NUMBER_ROUTES = ['NUMBER#*'];
const WIDGET_ROUTES = ['WIDGET#*'];
/** Customer tools also answer ElevenAgents webhook tools, which identify the tenant through the agent route. */
const ENGINE_AGENT_ROUTES = ['ENGINEAGENT#*'];

/** Route table mirrors contracts/openapi/tenant-tools.yaml. voice=true -> provisioned concurrency (Add-9). `routeReads` is
 *  the only route data the function may read (SEC-11); none means it may not read any. Owner: T7. */
const ROUTES: Array<{ method: apigw.HttpMethod; path: string; handler: string; voice?: boolean; auth: 'token' | 'iam'; routeReads?: string[] }> = [
  { method: apigw.HttpMethod.POST, path: '/v1/tools/availability', handler: 'check-availability', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings', handler: 'create-booking', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings/{bookingId}/reschedule', handler: 'reschedule-booking', auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/bookings/{bookingId}/cancel', handler: 'cancel-booking', auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/messages', handler: 'take-message', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/kb/search', handler: 'search-knowledge', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/caller/lookup', handler: 'lookup-caller', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/v1/tools/handoff', handler: 'request-handoff', voice: true, auth: 'token', routeReads: ENGINE_AGENT_ROUTES },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/reports/summary', handler: 'admin-summary', auth: 'token' },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/bookings', handler: 'admin-list-bookings', auth: 'token' },
  { method: apigw.HttpMethod.GET, path: '/v1/admin/conversations', handler: 'admin-list-conversations', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/admin/changes', handler: 'admin-propose-change', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/v1/admin/changes/apply', handler: 'admin-apply-change', auth: 'token' },
  { method: apigw.HttpMethod.PUT, path: '/v1/admin/hours', handler: 'admin-update-hours', auth: 'token' },
  { method: apigw.HttpMethod.PATCH, path: '/v1/admin/services/{serviceId}', handler: 'admin-update-service', auth: 'token' },
  { method: apigw.HttpMethod.POST, path: '/internal/resolve/number', handler: 'internal-resolve-number', voice: true, auth: 'iam', routeReads: NUMBER_ROUTES },
  { method: apigw.HttpMethod.POST, path: '/internal/resolve/widget', handler: 'internal-resolve-widget', voice: true, auth: 'iam', routeReads: WIDGET_ROUTES },
];

export class ApiStack extends Stack {
  readonly url: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    // stepUpCurrent/stepUpPrevious sign the dashboard's price-edit proof. They must differ from the token keys (deps.ts ignores a match).
    const secret = new sm.Secret(this, 'ToolApiSecret', { description: 'tokenCurrent, tokenPrevious, engineSecret, stepUpCurrent, stepUpPrevious' });
    // Browser calls from the dashboard need CORS; off until the origins are named (`-c dashboardOrigins=https://app.example.com,...`).
    const origins = String(this.node.tryGetContext('dashboardOrigins') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    for (const o of origins) if (!/^https:\/\/[^\s*/]+$/.test(o)) throw new Error(`dashboardOrigins: "${o}" is not an https origin (no wildcard, no path)`);
    const api = new apigw.HttpApi(this, 'ToolApi', {
      apiName: `${id}-tools`,
      ...(origins.length ? {
        corsPreflight: {
          allowOrigins: origins,
          allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.PATCH],
          allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-step-up-token'],
          // X-Next-Cursor pages listBookings/listConversations (CR T3-1); Retry-After tells the dashboard how long a 429 lasts.
          exposeHeaders: ['X-Next-Cursor', 'Retry-After'],
          maxAge: Duration.hours(1),
        },
      } : {}),
    });
    const rps = positive(this.node.tryGetContext('toolApiThrottleRps'), DEFAULT_THROTTLE_RPS);
    const stageSettings = api.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    if (!stageSettings) throw new Error('the tool API needs its default stage to carry the throttle');
    stageSettings.defaultRouteSettings = {
      throttlingRateLimit: rps,
      throttlingBurstLimit: Math.max(rps, positive(this.node.tryGetContext('toolApiThrottleBurst'), DEFAULT_THROTTLE_BURST)),
    };
    const vectorBucket = String(this.node.tryGetContext('knowledgeVectorBucket') ?? '').trim();
    const vectorIndex = String(this.node.tryGetContext('knowledgeVectorIndex') ?? '').trim();
    const embedDimensions = this.node.tryGetContext('knowledgeEmbedDimensions');
    // Both names go into an IAM resource ARN: no wildcards, no surprises.
    for (const [what, name] of [['knowledgeVectorBucket', vectorBucket], ['knowledgeVectorIndex', vectorIndex]] as const) {
      if (name && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) throw new Error(`${what}: "${name}" is not a valid S3 Vectors name`);
    }
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
          // The Route dimension of the ToolLatencyMs metric http.ts publishes (CR P7-2): the handler file name.
          TOOL_API_ROUTE: r.handler,
          ...(r.handler === 'search-knowledge' && vectorBucket && vectorIndex ? {
            KNOWLEDGE_VECTOR_BUCKET: vectorBucket, KNOWLEDGE_VECTOR_INDEX: vectorIndex,
            ...(embedDimensions ? { KNOWLEDGE_EMBED_DIMENSIONS: String(embedDimensions) } : {}),
          } : {}),
        },
        bundling: { format: nodejs.OutputFormat.ESM, minify: true, sourceMap: true },
      });
      secret.grantRead(fn);
      props.events.bus.grantPutEventsTo(fn);
      if (r.routeReads?.length) {
        // Only the route items this function needs (SEC-11). The shared grantRouteRead (every route family, Query too) is
        // for the router and token endpoints; a tool API function never needs sign-up, referral or identity routes.
        props.data.dataKey.grantDecrypt(fn);
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['dynamodb:GetItem'], resources: [props.data.table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': r.routeReads } },
        }));
      }
      if (r.handler === 'search-knowledge' && vectorBucket && vectorIndex) {
        // Semantic knowledge search: query this one index and embed with this one model, from this one function.
        // GetVectors is what QueryVectors needs to return metadata. The index and bucket come from the knowledge lane.
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
          resources: [`arn:${this.partition}:s3vectors:${this.region}:${this.account}:bucket/${vectorBucket}/index/${vectorIndex}`],
        }));
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'], resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${EMBED_MODEL_ID}`],
        }));
      }
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
