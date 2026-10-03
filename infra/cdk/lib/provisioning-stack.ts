import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { bundlingProps, fromRoot } from './paths.js';
import { nodeFn } from './lambda.js';
import type { EventsStack } from './events-stack.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/**
 * Change-7: "the agent asks, the workflow does". Execution name = onboardingId, so StartExecution is idempotent.
 * Owner decisions are waitForTaskToken steps completed by the onboarding internal API. Owner: D5.
 */
export class ProvisioningStack extends Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    // Account-level Telnyx credentials (JSON keys TELNYX_API_KEY, TELNYX_CONNECTION_ID). Values are pushed by the owner
    // (scripts/secrets/push.sh); nothing is stored in code. Only the number steps may read it.
    const telnyxSecret = new sm.Secret(this, 'TelnyxSecret', { description: 'TELNYX_API_KEY, TELNYX_CONNECTION_ID (FQDN connection to LiveKit SIP)' });
    const table = props.data.table;
    const routeKeys = ['NUMBER#*', 'ENGINEAGENT#*'];
    const tenantKeys = ['TENANT#*'];

    const step = (name: string, file: string) => new nodejs.NodejsFunction(this, `Step-${name}`, {
      ...bundlingProps, entry: fromRoot(`services/provisioning/src/steps/${file}.ts`), runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(60), environment: { TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName },
      bundling: { format: nodejs.OutputFormat.ESM, minify: true },
    });
    /** Item-level write access limited by leading key, plus the table's CMK. No unconditioned dynamodb:*. */
    const allowItems = (fn: lambda.Function, actions: string[], leadingKeys: string[]) => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions, resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leadingKeys } },
      }));
      table.encryptionKey?.grantEncryptDecrypt(fn);
    };
    const invoke = (name: string, file: string, resultPath: string, setup?: (fn: lambda.Function) => void, retry?: { errors: string[]; maxAttempts: number; interval: Duration; backoffRate: number }) => {
      const fn = step(name, file);
      setup?.(fn);
      return new tasks.LambdaInvoke(this, name, {
        lambdaFunction: fn, resultPath, payloadResponseOnly: true,
        retryOnServiceExceptions: true,
      }).addRetry(retry ?? { errors: ['States.TaskFailed'], maxAttempts: 2, interval: Duration.seconds(5), backoffRate: 2 });
    };
    // Number steps retry only transient Telnyx trouble. NoNumberAvailable / TelnyxRejectedError / RouteConflict are
    // not retried: they fall through to the Build catch. A retried OrderNumber can never buy twice (steps/order-number.ts).
    const transientTelnyx = (maxAttempts: number, seconds: number) => ({ errors: ['TelnyxTransientError'], maxAttempts, interval: Duration.seconds(seconds), backoffRate: 2 });
    const waitOwner = (name: string, what: string) => new tasks.LambdaInvoke(this, name, {
      lambdaFunction: step(name, 'await-owner'), integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ token: sfn.JsonPath.taskToken, onboardingId: sfn.JsonPath.stringAt('$.onboardingId'), what }),
      resultPath: `$.owner.${what}`, taskTimeout: sfn.Timeout.duration(Duration.days(3)),
    });

    // Number branch. Each step receives the whole workflow state and picks what it needs:
    //   input: onboardingId, tenantId (set server-side when provisioning starts), area { areaCode?, state? }
    //   SearchNumber -> $.number.search { candidates, matchedOn } -> OrderNumber -> $.number.order { number, orderId }
    //   -> BindEngine -> $.number.binding { number, engine, agentId }
    const numberBranch = invoke('SearchNumber', 'search-number', '$.number.search',
      (fn) => telnyxSecret.grantRead(fn), transientTelnyx(3, 2))
      .next(invoke('OrderNumber', 'order-number', '$.number.order',
        (fn) => { telnyxSecret.grantRead(fn); allowItems(fn, ['dynamodb:GetItem', 'dynamodb:PutItem'], tenantKeys); }, transientTelnyx(4, 3)))
      .next(invoke('BindEngine', 'bind-engine', '$.number.binding',
        (fn) => { telnyxSecret.grantRead(fn); allowItems(fn, ['dynamodb:PutItem'], routeKeys); }, transientTelnyx(6, 3)));
    const knowledgeBranch = invoke('ScrapeKnowledge', 'scrape-knowledge', '$.knowledge')
      .next(waitOwner('AwaitFactsConfirmed', 'facts'));
    const profileBranch = waitOwner('AwaitProfileComplete', 'profile'); // hours + services confirmed in chat

    // Abuse control before money is spent on a number (D9). No card -> owner is asked in chat; workflow waits.
    const payment = invoke('CheckPaymentMethod', 'check-payment-method', '$.payment');

    const parallel = new sfn.Parallel(this, 'Build', { resultPath: '$.build' })
      .branch(numberBranch).branch(knowledgeBranch).branch(profileBranch);

    const failed = new sfn.Pass(this, 'NotifyFailure'); // TODO(W1-13): emit onboarding.status failed + support triage
    parallel.addCatch(failed, { resultPath: '$.error' });

    const definition = payment.next(parallel)
      .next(invoke('RenderAgent', 'render-agent', '$.agent'))
      .next(waitOwner('AwaitAgentName', 'agentName'))
      .next(invoke('SmokeCall', 'smoke-call', '$.smoke'))
      .next(invoke('ActivateTenant', 'activate-tenant', '$.activation'));

    this.stateMachine = new sfn.StateMachine(this, 'Provisioning', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.days(7),
      tracingEnabled: true,
    });

    // Onboarding internal API (service-token auth in code; contracts/openapi/onboarding-internal.yaml)
    const api = new apigw.HttpApi(this, 'OnboardingApi', { apiName: `${id}-onboarding` });
    const env = { TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName, STATE_MACHINE_ARN: this.stateMachine.stateMachineArn };
    const routes: Array<[string, apigw.HttpMethod[], string]> = [
      ['/internal/onboarding/{id}/basics', [apigw.HttpMethod.POST], 'basics'],
      ['/internal/onboarding/{id}/waitlist', [apigw.HttpMethod.POST], 'waitlist'],
      ['/internal/onboarding/{id}/provisioning', [apigw.HttpMethod.GET, apigw.HttpMethod.POST], 'provisioning'],
      ['/internal/onboarding/{id}/hours', [apigw.HttpMethod.POST], 'parse-profile'],
      ['/internal/onboarding/{id}/services', [apigw.HttpMethod.POST], 'parse-profile'],
      ['/internal/onboarding/{id}/facts', [apigw.HttpMethod.GET], 'facts'],
      ['/internal/onboarding/{id}/facts/decisions', [apigw.HttpMethod.POST], 'facts'],
      ['/internal/onboarding/{id}/agent-name', [apigw.HttpMethod.POST], 'agent-name'],
      ['/internal/onboarding/{id}/signup-link', [apigw.HttpMethod.POST], 'signup-link'],
      ['/internal/onboarding/{id}/payment-setup', [apigw.HttpMethod.POST], 'payment-setup'],
      ['/signup/callback', [apigw.HttpMethod.GET], 'signup-callback'],
    ];
    const fns = new Map<string, lambda.IFunction>();
    for (const [path, methods, file] of routes) {
      let f = fns.get(file);
      if (!f) {
        const created = nodeFn(this, `Api-${file}`, `services/provisioning/src/api/${file}.ts`, { timeoutSec: 29, memory: 512, env });
        this.stateMachine.grantStartExecution(created);
        this.stateMachine.grantTaskResponse(created);
        props.events.bus.grantPutEventsTo(created);
        fns.set(file, created);
        f = created;
      }
      api.addRoutes({ path, methods, integration: new HttpLambdaIntegration(`Int-${file}-${path}`, f) });
    }
  }
}
