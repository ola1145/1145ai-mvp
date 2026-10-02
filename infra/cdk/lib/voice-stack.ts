import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { DataStack } from './data-stack.js';
import { bundlingProps, fromRoot } from './paths.js';
import type { EventsStack } from './events-stack.js';

interface Props extends StackProps { data: DataStack; events: EventsStack; toolApiUrl: string }

/** frontdesk worker on ECS Fargate. It dials OUT to LiveKit, so there is no load balancer and no inbound port. */
export class VoiceStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENHANCED });
    const secrets = new sm.Secret(this, 'VoiceSecrets', { description: 'LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, DEEPGRAM_API_KEY, ELEVEN_API_KEY' });

    const task = new ecs.FargateTaskDefinition(this, 'Task', { cpu: 2048, memoryLimitMiB: 4096, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 } });
    const env = (k: string) => ecs.Secret.fromSecretsManager(secrets, k);
    task.addContainer('frontdesk', {
      image: ecs.ContainerImage.fromAsset(fromRoot('engines/livekit-agent')),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'frontdesk', logRetention: logs.RetentionDays.ONE_MONTH }),
      environment: { TOOL_API_URL: props.toolApiUrl, RESOLVER_URL: props.toolApiUrl, EVENT_BUS_NAME: props.events.bus.eventBusName, TENANT_BUCKET: props.data.tenantBucket.bucketName },
      secrets: { LIVEKIT_URL: env('LIVEKIT_URL'), LIVEKIT_API_KEY: env('LIVEKIT_API_KEY'), LIVEKIT_API_SECRET: env('LIVEKIT_API_SECRET'), DEEPGRAM_API_KEY: env('DEEPGRAM_API_KEY'), ELEVEN_API_KEY: env('ELEVEN_API_KEY') },
    });
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/internal/resolve/number`] }));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'] }));
    props.data.tenantBucket.grantPut(task.taskRole, 'tenants/*/transcripts/*');
    props.events.bus.grantPutEventsTo(task.taskRole);

    const service = new ecs.FargateService(this, 'Service', {
      cluster, taskDefinition: task, desiredCount: 2, minHealthyPercent: 100, maxHealthyPercent: 200,
      // Draining: LiveKit workers finish active jobs on SIGTERM; give calls time to end.
      enableExecuteCommand: false, circuitBreaker: { rollback: true },
    });
    const scaling = service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 50, scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.minutes(10) });
  }
}
