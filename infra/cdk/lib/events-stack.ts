import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import type { Construct } from 'constructs';

/** The event bus only (owner: C0). Auth and realtime live in their own stacks so separate lanes own them. */
export class EventsStack extends Stack {
  readonly bus: events.EventBus;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: `${id}-1145` });
    this.bus.archive('Archive', { eventPattern: { source: [{ prefix: '1145.' }] as unknown as string[] }, retention: Duration.days(30) });
  }
}
