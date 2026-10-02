import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { bundlingProps, fromRoot } from './paths.js';
import type { EventsStack } from './events-stack.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/**
 * Change-7: "the agent asks, the workflow does". Execution name = onboardingId, so StartExecution is idempotent.
 * Owner decisions are waitForTaskToken steps completed by the onboarding internal API.
 */
export class ProvisioningStack extends Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const step = (name: string, file: string) => new nodejs.NodejsFunction(this, `Step-${name}`, {
      ...bundlingProps, entry: fromRoot(`services/provisioning/src/steps/${file}.ts`), runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(60), environment: { TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName },
      bundling: { format: nodejs.OutputFormat.ESM, minify: true },
    });
    const invoke = (name: string, file: string, resultPath: string) => new tasks.LambdaInvoke(this, name, {
      lambdaFunction: step(name, file), resultPath, payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    }).addRetry({ errors: ['States.TaskFailed'], maxAttempts: 2, interval: Duration.seconds(5), backoffRate: 2 });
    const waitOwner = (name: string, what: string) => new tasks.LambdaInvoke(this, name, {
      lambdaFunction: step(name, 'await-owner'), integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ token: sfn.JsonPath.taskToken, onboardingId: sfn.JsonPath.stringAt('$.onboardingId'), what }),
      resultPath: `$.owner.${what}`, taskTimeout: sfn.Timeout.duration(Duration.days(3)),
    });

    const numberBranch = invoke('SearchNumber', 'search-number', '$.number.candidates')
      .next(invoke('OrderNumber', 'order-number', '$.number.order'))
      .next(invoke('BindEngine', 'bind-engine', '$.number.binding'));
    const knowledgeBranch = invoke('ScrapeKnowledge', 'scrape-knowledge', '$.knowledge')
      .next(waitOwner('AwaitFactsConfirmed', 'facts'));
    const profileBranch = waitOwner('AwaitProfileComplete', 'profile'); // hours + services confirmed in chat

    const parallel = new sfn.Parallel(this, 'Build', { resultPath: '$.build' })
      .branch(numberBranch).branch(knowledgeBranch).branch(profileBranch);

    const failed = new sfn.Pass(this, 'NotifyFailure'); // TODO(W1-13): emit onboarding.status failed + support triage
    parallel.addCatch(failed, { resultPath: '$.error' });

    const definition = parallel
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
  }
}
