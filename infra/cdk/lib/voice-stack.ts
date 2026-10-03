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
  /**
   * The Vpc construct reads `stack.availabilityZones`, which for an account/region-bound stack is an AWS lookup at synth
   * time (it fails in CI, where there are no credentials, and only passes locally from a cached cdk.context.json). Pin
   * the two zones instead; `a` and `b` exist in every region we deploy to.
   */
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENHANCED });
    // The runtime secret that scripts/secrets/push.sh fills from .env (names in docs/API_KEYS.md); no second secret to fill by hand.
    const stage: string = this.node.tryGetContext('stage') ?? 'dev';
    const secrets = sm.Secret.fromSecretNameV2(this, 'RuntimeSecrets', `1145/${stage}/runtime`);

    const task = new ecs.FargateTaskDefinition(this, 'Task', { cpu: 2048, memoryLimitMiB: 4096, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 } });
    const env = (k: string) => ecs.Secret.fromSecretsManager(secrets, k);
    task.addContainer('frontdesk', {
      image: ecs.ContainerImage.fromAsset(fromRoot('engines/livekit-agent')),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'frontdesk', logRetention: logs.RetentionDays.ONE_MONTH }),
      // Give the in-flight calls the longest stop window Fargate allows before SIGKILL (120 s max).
      stopTimeout: Duration.seconds(120),
      environment: {
        TOOL_API_URL: props.toolApiUrl, RESOLVER_URL: props.toolApiUrl, EVENT_BUS_NAME: props.events.bus.eventBusName, TENANT_BUCKET: props.data.tenantBucket.bucketName,
        // Not a secret (docs/API_KEYS.md). Set with `cdk deploy -c elevenlabsDefaultVoiceId=...` or leave empty to rely on tenant voices.
        ELEVENLABS_DEFAULT_VOICE_ID: this.node.tryGetContext('elevenlabsDefaultVoiceId') ?? '',
      },
      secrets: {
        LIVEKIT_URL: env('LIVEKIT_URL'), LIVEKIT_API_KEY: env('LIVEKIT_API_KEY'), LIVEKIT_API_SECRET: env('LIVEKIT_API_SECRET'), DEEPGRAM_API_KEY: env('DEEPGRAM_API_KEY'),
        // The LiveKit ElevenLabs plugin reads ELEVEN_API_KEY; the shared secret stores it as ELEVENLABS_API_KEY.
        ELEVEN_API_KEY: env('ELEVENLABS_API_KEY'), ELEVENLABS_API_KEY: env('ELEVENLABS_API_KEY'),
      },
    });
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/internal/resolve/number`] }));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'] }));
    // Lets the worker mark its task protected while a call is live, so deploys and scale-in wait for it (see change request E1-2).
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ecs:UpdateTaskProtection', 'ecs:GetTaskProtection'], resources: [`arn:aws:ecs:${this.region}:${this.account}:task/*/*`] }));
    props.data.tenantBucket.grantPut(task.taskRole, 'tenants/*/transcripts/*');
    props.events.bus.grantPutEventsTo(task.taskRole);

    const service = new ecs.FargateService(this, 'Service', {
      cluster, taskDefinition: task, desiredCount: 2, minHealthyPercent: 100, maxHealthyPercent: 200,
      // Rolling deploy: new tasks start first (200%) and old ones keep 100% healthy capacity, so a deploy never drops below
      // full strength. Old tasks get SIGTERM, the LiveKit worker stops taking new calls and finishes the live ones; calls
      // longer than the stop window are covered by task protection.
      enableExecuteCommand: false, circuitBreaker: { rollback: true },
    });
    const scaling = service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 50, scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.minutes(10) });
  }
}
