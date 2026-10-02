import { App } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { ChannelsStack } from '../lib/channels-stack.js';
import { ControlPlaneStack } from '../lib/controlplane-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { EventsStack } from '../lib/events-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';
import { NotificationsStack } from '../lib/notifications-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';
import { PostCallStack } from '../lib/postcall-stack.js';
import { ProvisioningStack } from '../lib/provisioning-stack.js';
import { RealtimeStack } from '../lib/realtime-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

/** Every stack is pre-wired so lanes only ever edit the stack file they own (owner of this file: P2). */
const app = new App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
const p = (n: string) => `ai1145-${stage}-${n}`; // stack names must start with a letter

const data = new DataStack(app, p('data'), { env });
const events = new EventsStack(app, p('events'), { env });
const auth = new AuthStack(app, p('auth'), { env, data, stage });
new RealtimeStack(app, p('realtime'), { env, auth, events });
const api = new ApiStack(app, p('api'), { env, data, events, auth });
new ChannelsStack(app, p('channels'), { env, data, events, auth });
new ProvisioningStack(app, p('provisioning'), { env, data, events });
new VoiceStack(app, p('voice'), { env, data, events, toolApiUrl: api.url });
new PostCallStack(app, p('postcall'), { env, data, events });
new NotificationsStack(app, p('notifications'), { env, data, events });
new ControlPlaneStack(app, p('controlplane'), { env, data, events });
new ObservabilityStack(app, p('observability'), { env });

const repo = app.node.tryGetContext('repo');
if (repo) new GithubOidcStack(app, 'ai1145-github-oidc', { env, repo, environments: ['dev', 'prod'] });
