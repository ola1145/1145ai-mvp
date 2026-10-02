import { Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import type { EventsStack } from './events-stack.js';
import { nodeFn } from './lambda.js';

interface Props extends StackProps { data: DataStack; events: EventsStack }

/** Owner notifications: Telegram, email (Resend), web push, urgent call. No SMS/WhatsApp in MVP (owner: C6). */
export class NotificationsStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const fn = nodeFn(this, 'Dispatcher', 'services/notifications/src/dispatcher.ts', { timeoutSec: 30, env: { TABLE_NAME: props.data.table.tableName } });
    props.data.grantRouteRead(fn);
    new events.Rule(this, 'OwnerWorthy', {
      eventBus: props.events.bus,
      eventPattern: { detailType: ['booking.created', 'booking.cancelled', 'message.taken', 'handoff.requested', 'usage.recorded', 'tenant.state_changed', 'tenant.provisioned'] },
      targets: [new targets.LambdaFunction(fn)],
    });
  }
}
