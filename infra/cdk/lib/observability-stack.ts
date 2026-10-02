import { Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/** Dashboards and alarms (owner: P7). TODO(P7): per-route tool p95, failed calls, DLQ depth, AgentCore errors. */
export class ObservabilityStack extends Stack {
  readonly alarmTopic: sns.Topic;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.alarmTopic = new sns.Topic(this, 'Alarms');
    new cloudwatch.Dashboard(this, 'Ops', { dashboardName: `${id}-ops` });
  }
}
