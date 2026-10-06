import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { describe, expect, it } from 'vitest';
import { ObservabilityStack } from '../lib/observability-stack.js';

function build(opts: { email?: string; wired?: boolean; stage?: string } = {}) {
  const app = new App({ context: { stage: opts.stage ?? 'dev' } });
  const src = new Stack(app, 'Src');
  const dlq = new sqs.Queue(src, 'InboundDlq', { fifo: true, retentionPeriod: Duration.days(14) });
  const inbound = new sqs.Queue(src, 'Inbound', { fifo: true, deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
  const wired = opts.wired ?? true;
  const stack = new ObservabilityStack(app, 'Obs', {
    alarmEmail: opts.email ?? 'ops@example.com',
    ...(wired ? { apiIds: ['tool-api-id', 'hooks-api-id'], dlqs: [dlq], fifoQueues: [inbound] } : {}),
  });
  return Template.fromStack(stack);
}

const alarmsWhere = (t: Template, props: Record<string, unknown>) => t.findResources('AWS::CloudWatch::Alarm', { Properties: props });

describe('ObservabilityStack alarms', () => {
  it('alarms when tool p95 latency exceeds 300 ms, per voice route', () => {
    const t = build();
    const p95 = alarmsWhere(t, { MetricName: 'ToolLatencyMs', ExtendedStatistic: 'p95', Threshold: 300, ComparisonOperator: 'GreaterThanThreshold' });
    expect(Object.keys(p95).length).toBeGreaterThanOrEqual(6);
    const routes = Object.values(p95).flatMap((r) => (r.Properties.Dimensions as Array<{ Name: string; Value: string }>).filter((d) => d.Name === 'Route').map((d) => d.Value));
    expect(routes).toEqual(expect.arrayContaining(['check-availability', 'create-booking', 'take-message', 'search-knowledge', 'lookup-caller', 'request-handoff']));
  });

  it('alarms on more than 2 failed calls in 10 minutes', () => {
    const t = build();
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Ai1145', MetricName: 'CallFailed', Statistic: 'Sum', Period: 600, EvaluationPeriods: 1,
      Threshold: 2, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching',
    });
  });

  it('alarms when any DLQ has a visible message', () => {
    const t = build();
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching',
    });
  });

  it('alarms on API 5xx bursts for every wired API', () => {
    const t = build();
    const a = alarmsWhere(t, { Namespace: 'AWS/ApiGateway', MetricName: '5xx', Statistic: 'Sum', ComparisonOperator: 'GreaterThanOrEqualToThreshold' });
    expect(Object.keys(a)).toHaveLength(2);
  });

  it('always has the call and tool alarms even before queues and APIs are wired in', () => {
    const t = build({ wired: false });
    t.resourceCountIs('AWS::CloudWatch::Alarm', 6 + 1 + 1); // 6 routes, failed calls, account Lambda errors
  });

  it('every alarm notifies the topic on ALARM and OK', () => {
    const t = build();
    const topics = Object.keys(t.findResources('AWS::SNS::Topic'));
    expect(topics).toHaveLength(1);
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms.length).toBeGreaterThan(0);
    for (const a of alarms) {
      expect(a.Properties.AlarmActions).toEqual([{ Ref: topics[0] }]);
      expect(a.Properties.OKActions).toEqual([{ Ref: topics[0] }]);
    }
  });
});

describe('ObservabilityStack topic', () => {
  it('subscribes by email only, never SMS', () => {
    const t = build({ email: 'owner@example.com' });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'owner@example.com' });
    expect(Object.values(t.findResources('AWS::SNS::Subscription')).every((s) => s.Properties.Protocol === 'email')).toBe(true);
  });

  it('refuses to synth prod without an alarm email', () => {
    const app = new App({ context: { stage: 'prod' } });
    expect(() => new ObservabilityStack(app, 'Obs', {})).toThrow(/alarmEmail/);
  });

  it('requires TLS on the topic', () => {
    const t = build();
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });
});

describe('ObservabilityStack dashboard', () => {
  it('covers calls, failures, tool latency, FIFO age, AgentCore errors and minutes by tenant', () => {
    const t = build();
    const [dash] = Object.values(t.findResources('AWS::CloudWatch::Dashboard'));
    const body = JSON.stringify(dash.Properties.DashboardBody);
    for (const needle of ['CallStarted', 'CallFailed', 'ToolLatencyMs', 'ApproximateAgeOfOldestMessage', 'Bedrock-AgentCore', 'CallMinutes', 'TenantId']) {
      expect(body, needle).toContain(needle);
    }
  });

  it('ships a saved Logs Insights query to trace one call end to end', () => {
    const t = build();
    t.hasResourceProperties('AWS::Logs::QueryDefinition', { QueryString: Match.stringLikeRegexp('sort @timestamp asc') });
  });
});
