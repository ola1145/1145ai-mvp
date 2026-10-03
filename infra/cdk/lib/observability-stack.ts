import { Annotations, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Custom metrics the services publish as CloudWatch EMF (see contracts/CHANGE_REQUESTS/P7-2.md).
 * Namespace and names are the contract between this stack and the emitters.
 */
export const METRICS = {
  namespace: 'Ai1145',
  callStarted: 'CallStarted',
  callCompleted: 'CallCompleted',
  callFailed: 'CallFailed',
  toolLatencyMs: 'ToolLatencyMs', // dimension: Route (the tool-api handler name)
  callMinutes: 'CallMinutes', // dimension: TenantId
} as const;

/** Routes on the voice path: the ones a caller waits on, so the ones with a latency budget (mirrors voice:true in api-stack). */
export const VOICE_TOOL_ROUTES = [
  'check-availability', 'create-booking', 'take-message', 'search-knowledge', 'lookup-caller', 'request-handoff',
] as const;

export interface ObservabilityProps extends StackProps {
  /** Where alarm emails go. Falls back to `-c alarmEmail=...`. Required for stage=prod. Email only, no SMS in the MVP. */
  alarmEmail?: string;
  /** HTTP API ids to alarm on 5xx (tool API, channel hooks). */
  apiIds?: string[];
  /** Dead-letter queues. Any visible message pages the owner. */
  dlqs?: sqs.IQueue[];
  /** Work queues whose oldest-message age is charted (the channel router FIFO). */
  fifoQueues?: sqs.IQueue[];
  /** Override the per-route latency alarms. Defaults to the voice routes. */
  toolRoutes?: readonly string[];
}

const TOOL_P95_MS = 300;
const FAILED_CALLS_PER_10_MIN = 2;
const API_5XX_PER_5_MIN = 3;
const LAMBDA_ERRORS_PER_5_MIN = 3;

/** Dashboards and alarms (owner: P7). Alarms go to one SNS topic, subscribed by email. See docs/runbooks/alarms.md. */
export class ObservabilityStack extends Stack {
  readonly alarmTopic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityProps = {}) {
    super(scope, id, props);
    const stage: string = this.node.tryGetContext('stage') ?? 'dev';
    const email: string | undefined = props.alarmEmail ?? this.node.tryGetContext('alarmEmail');
    const apiIds = props.apiIds ?? [];
    const dlqs = props.dlqs ?? [];
    const fifoQueues = props.fifoQueues ?? [];
    const routes = props.toolRoutes ?? VOICE_TOOL_ROUTES;
    const ns = METRICS.namespace;

    this.alarmTopic = new sns.Topic(this, 'Alarms', { displayName: '1145 alerts', enforceSSL: true });
    if (email) {
      this.alarmTopic.addSubscription(new subs.EmailSubscription(email));
    } else if (stage === 'prod') {
      throw new Error('ObservabilityStack: alarmEmail is required for stage=prod (pass -c alarmEmail=you@example.com)');
    } else {
      Annotations.of(this).addWarningV2('1145:no-alarm-email', 'No alarmEmail set: alarms fire but nobody is emailed. Pass -c alarmEmail=you@example.com.');
    }
    const notify = new cwActions.SnsAction(this.alarmTopic);
    const alarm = (name: string, metric: cloudwatch.IMetric, o: Omit<cloudwatch.CreateAlarmOptions, 'alarmName'> & { description: string }) => {
      const a = metric instanceof cloudwatch.Metric
        ? metric.createAlarm(this, name, { alarmName: `${id}-${name}`, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, ...o })
        : new cloudwatch.Alarm(this, name, { alarmName: `${id}-${name}`, metric, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, ...o });
      a.addAlarmAction(notify);
      a.addOkAction(notify);
      return a;
    };

    // Calls
    const metric = (name: string, statistic: string, period: Duration, dimensionsMap?: Record<string, string>) =>
      new cloudwatch.Metric({ namespace: ns, metricName: name, statistic, period, dimensionsMap });
    const callFailed = metric(METRICS.callFailed, 'Sum', Duration.minutes(10));
    alarm('FailedCalls', callFailed, {
      threshold: FAILED_CALLS_PER_10_MIN, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      description: `More than ${FAILED_CALLS_PER_10_MIN} failed calls in 10 minutes. Runbook: docs/runbooks/alarms.md#failed-calls`,
    });

    // Tool latency, p95 per route. 2 of 3 five-minute windows so one cold start does not page.
    const toolP95 = routes.map((route) => {
      const m = metric(METRICS.toolLatencyMs, 'p95', Duration.minutes(5), { Route: route });
      alarm(`ToolP95-${route}`, m, {
        threshold: TOOL_P95_MS, evaluationPeriods: 3, datapointsToAlarm: 2, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        description: `Tool ${route} p95 over ${TOOL_P95_MS} ms. Runbook: docs/runbooks/alarms.md#slow-tool`,
      });
      return m;
    });

    // Every Lambda in the account, no dimension: catches a tool or router function that throws before any custom metric is written.
    const lambdaErrors = new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', period: Duration.minutes(5) });
    alarm('LambdaErrors', lambdaErrors, {
      threshold: LAMBDA_ERRORS_PER_5_MIN, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      description: `${LAMBDA_ERRORS_PER_5_MIN}+ Lambda errors in 5 minutes. Runbook: docs/runbooks/alarms.md#api-5xx`,
    });

    // API 5xx burst
    const api5xx = apiIds.map((apiId, i) => {
      const m = new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: '5xx', statistic: 'Sum', period: Duration.minutes(5), dimensionsMap: { ApiId: apiId } });
      alarm(`Api5xx-${i + 1}`, m, {
        threshold: API_5XX_PER_5_MIN, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        description: `${API_5XX_PER_5_MIN}+ 5xx responses in 5 minutes on API ${apiId}. Runbook: docs/runbooks/alarms.md#api-5xx`,
      });
      return m;
    });

    // DLQ depth
    const dlqDepth = dlqs.map((q, i) => {
      const m = q.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' });
      alarm(`Dlq-${i + 1}`, m, {
        threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        description: 'A message landed in a dead-letter queue. Runbook: docs/runbooks/alarms.md#dlq',
      });
      return m;
    });

    // Dashboard
    const w = 8;
    const search = (q: string, period: number, label: string) =>
      new cloudwatch.MathExpression({ expression: `SEARCH('${q}', 'Sum', ${period})`, usingMetrics: {}, period: Duration.seconds(period), label });
    this.dashboard = new cloudwatch.Dashboard(this, 'Ops', { dashboardName: `${id}-ops` });
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', width: 24, height: 3, alarms: this.node.findAll().filter((c): c is cloudwatch.Alarm => c instanceof cloudwatch.Alarm) }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Calls', width: w, left: [metric(METRICS.callStarted, 'Sum', Duration.minutes(5)), metric(METRICS.callCompleted, 'Sum', Duration.minutes(5))] }),
      new cloudwatch.GraphWidget({
        title: 'Failed calls (alarm above 2 in 10 min)', width: w, left: [callFailed],
        leftAnnotations: [{ value: FAILED_CALLS_PER_10_MIN, label: 'alarm' }],
      }),
      new cloudwatch.GraphWidget({
        title: 'Tool latency p95 per route (ms)', width: w, left: toolP95,
        leftAnnotations: [{ value: TOOL_P95_MS, label: 'alarm' }],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Tool latency p50 per route (ms)', width: w,
        left: routes.map((r) => metric(METRICS.toolLatencyMs, 'p50', Duration.minutes(5), { Route: r })),
      }),
      new cloudwatch.GraphWidget({ title: 'API 5xx', width: w, left: api5xx, leftAnnotations: [{ value: API_5XX_PER_5_MIN, label: 'alarm' }] }),
      new cloudwatch.GraphWidget({ title: 'Lambda errors (all functions)', width: w, left: [lambdaErrors] }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Router FIFO: age of oldest message (s)', width: w,
        left: fifoQueues.map((q, i) => q.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), statistic: 'Maximum', label: `fifo ${i + 1}` })),
      }),
      new cloudwatch.GraphWidget({ title: 'Dead-letter queue depth (alarm above 0)', width: w, left: dlqDepth, leftAnnotations: [{ value: 0, label: 'alarm' }] }),
      // Dimension-agnostic on purpose: shows whatever AgentCore publishes for the onboarding and admin runtimes.
      new cloudwatch.GraphWidget({
        title: 'AgentCore errors', width: w,
        left: [search('Namespace="AWS/Bedrock-AgentCore" MetricName="SystemErrors"', 300, 'system errors'), search('Namespace="AWS/Bedrock-AgentCore" MetricName="Throttles"', 300, 'throttles')],
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Call minutes by tenant (hourly)', width: 24, stacked: true,
        left: [search(`{${ns},TenantId} MetricName="${METRICS.callMinutes}"`, 3600, '')],
      }),
    );

    // One call end to end: paste the call id, room name or conversation id, pick the log groups, run.
    new logs.QueryDefinition(this, 'TraceOneCall', {
      queryDefinitionName: `${id}/trace-one-call`,
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@log', '@message'],
        filterStatements: ['@message like "REPLACE_WITH_CALL_ID"'],
        sort: '@timestamp asc',
        limit: 500,
      }),
    });
  }
}
