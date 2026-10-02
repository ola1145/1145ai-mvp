import { App } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { EventsStack } from '../lib/events-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { ChannelsStack } from '../lib/channels-stack.js';
import { ProvisioningStack } from '../lib/provisioning-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new App();
const stage = app.node.tryGetContext('stage') ?? 'dev';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
const p = (n: string) => `ai1145-${stage}-${n}`; // stack names must start with a letter

const data = new DataStack(app, p('data'), { env });
const events = new EventsStack(app, p('events'), { env });
const api = new ApiStack(app, p('api'), { env, data, events });
new ChannelsStack(app, p('channels'), { env, data, events });
new ProvisioningStack(app, p('provisioning'), { env, data, events });
new VoiceStack(app, p('voice'), { env, data, events, toolApiUrl: api.url });
