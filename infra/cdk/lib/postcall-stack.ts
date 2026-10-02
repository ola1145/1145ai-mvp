import { Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** call.ended -> analysis, CRM, usage, Stripe usage (owner: G3). */
export class PostCallStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const fn = nodeFn(this, 'PostCall', 'services/post-call/src/deps.ts', { timeoutSec: 60, memory: 512, env: { TABLE_NAME: props.data.table.tableName, EVENT_BUS_NAME: props.events.bus.eventBusName } });
    props.events.bus.grantPutEventsTo(fn);
    props.data.tenantBucket.grantRead(fn, 'tenants/*/transcripts/*');
    new events.Rule(this, 'CallEnded', { eventBus: props.events.bus, eventPattern: { detailType: ['call.ended'] }, targets: [new targets.LambdaFunction(fn, { retryAttempts: 4 })] });
  }
}
