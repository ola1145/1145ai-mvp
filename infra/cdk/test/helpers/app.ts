import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, vi } from 'vitest';
import type { DataStack } from '../../lib/data-stack.js';

/**
 * Synthesizes the real app, in memory. It runs infra/cdk/bin/app.ts itself, so the tests always see exactly the
 * stacks and wiring `cdk synth` builds, including stacks and props other lanes add later. Fake account id, no esbuild
 * bundling, nothing reaches AWS.
 *
 * bin/app.ts creates its own App and exports nothing, so one stack class is wrapped (vi.mock below) to hand back
 * the App it was created in. Context goes in through CDK_CONTEXT_JSON, which is how the cdk CLI passes `-c` values.
 */

const captured = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('../../lib/data-stack.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/data-stack.js')>();
  class CapturedDataStack extends original.DataStack {
    constructor(...args: ConstructorParameters<typeof original.DataStack>) {
      super(...args);
      captured.data = this;
    }
  }
  return { ...original, DataStack: CapturedDataStack };
});

const CDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every synthesized app writes a cloud assembly to a temp directory. Without asset staging it stays small, and it is
 * removed when the test file finishes.
 */
const outdirs = new Set<string>();
afterAll(() => { for (const dir of outdirs) fs.rmSync(dir, { recursive: true, force: true }); });
/** No esbuild bundling (the slow part of a real synth) and no copying of Docker or code assets into the assembly. */
const FAST_SYNTH = { 'aws:cdk:bundling-stacks': [], 'aws:cdk:disable-asset-staging': true };

export const ACCOUNT = '111111111111';
export const REGION = 'us-east-1';

export type Stage = 'dev' | 'prod';

export interface BuildOptions {
  stage?: Stage;
  /** Extra CDK context, e.g. `{ enableWhatsApp: 'true' }` (what `cdk synth -c enableWhatsApp=true` produces). */
  context?: Record<string, unknown>;
}

export interface Built {
  app: App;
  stage: Stage;
  data: DataStack;
  /** Every stack in the app, by short name: `ai1145-dev-api` is `api`. */
  stacks: Record<string, Stack>;
  /** Synthesized CloudFormation templates, by short name. */
  templates: Record<string, Template>;
}

/** Short names of the stacks bin/app.ts creates today. A sanity check, not a list to keep in sync: new stacks are picked up automatically. */
export const KNOWN_STACKS = ['data', 'events', 'auth', 'realtime', 'api', 'channels', 'provisioning', 'voice', 'postcall', 'notifications', 'controlplane', 'observability'];

export async function buildApp(opts: BuildOptions = {}): Promise<Built> {
  const stage = opts.stage ?? 'dev';
  // Prod refuses to synth the observability stack without an alarm email, so give it one.
  const context = { stage, ...FAST_SYNTH, ...(stage === 'prod' ? { alarmEmail: 'ops@example.com' } : {}), ...opts.context };

  const before = { cwd: process.cwd(), context: process.env.CDK_CONTEXT_JSON, account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
  const restore = (key: 'CDK_CONTEXT_JSON' | 'CDK_DEFAULT_ACCOUNT' | 'CDK_DEFAULT_REGION', value: string | undefined) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  // lib/paths.ts resolves the repo root from process.cwd() when it is imported (cdk runs inside infra/cdk).
  process.chdir(CDK_DIR);
  process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
  process.env.CDK_DEFAULT_ACCOUNT = ACCOUNT;
  process.env.CDK_DEFAULT_REGION = REGION;
  captured.data = undefined;
  try {
    vi.resetModules(); // bin/app.ts runs on import, so every build needs a fresh copy of it
    await import('../../bin/app.js');
  } finally {
    process.chdir(before.cwd);
    restore('CDK_CONTEXT_JSON', before.context);
    restore('CDK_DEFAULT_ACCOUNT', before.account);
    restore('CDK_DEFAULT_REGION', before.region);
  }

  const data = captured.data as DataStack | undefined;
  if (!data) throw new Error('bin/app.ts did not create a DataStack');
  const app = data.node.root as App;
  const stacks = Object.fromEntries(app.node.children.filter(Stack.isStack).map((s) => [s.stackName.replace(/^ai1145-(dev|prod)-/, ''), s]));
  const templates = Object.fromEntries(Object.entries(stacks).map(([key, stack]) => [key, Template.fromStack(stack)]));
  outdirs.add(app.outdir);
  return { app, stage, data, stacks, templates };
}

/** Synthesis takes seconds, so each test file shares one build per stage and context. Never mutate the result. */
const cache = new Map<string, Promise<Built>>();
export function sharedApp(opts: BuildOptions = {}): Promise<Built> {
  const key = JSON.stringify({ stage: opts.stage ?? 'dev', context: opts.context ?? {} });
  let built = cache.get(key);
  if (!built) {
    built = buildApp(opts);
    cache.set(key, built);
  }
  return built;
}

// Stacks for small purpose-built apps (negative controls, flag variations). Loaded from infra/cdk like bin/app.ts does.
async function loadStacks() {
  const previous = process.cwd();
  process.chdir(CDK_DIR);
  try {
    const [auth, channels, data, events] = await Promise.all([
      import('../../lib/auth-stack.js'), import('../../lib/channels-stack.js'), import('../../lib/data-stack.js'), import('../../lib/events-stack.js'),
    ]);
    return { AuthStack: auth.AuthStack, ChannelsStack: channels.ChannelsStack, DataStack: data.DataStack, EventsStack: events.EventsStack };
  } finally {
    process.chdir(previous);
  }
}
export const lib = await loadStacks();

/**
 * Just the stacks ChannelsStack needs, wired as in bin/app.ts, for tests that try one context flag many times
 * (a full build takes seconds).
 */
export function buildChannels(context: Record<string, unknown> = {}) {
  const app = new App({ context: { stage: 'dev', ...FAST_SYNTH, ...context } });
  const env = { account: ACCOUNT, region: REGION };
  const data = new lib.DataStack(app, 'ai1145-dev-data', { env });
  const events = new lib.EventsStack(app, 'ai1145-dev-events', { env });
  const auth = new lib.AuthStack(app, 'ai1145-dev-auth', { env, data, stage: 'dev' });
  const channels = new lib.ChannelsStack(app, 'ai1145-dev-channels', { env, data, events, auth });
  const template = Template.fromStack(channels);
  outdirs.add(app.outdir);
  return { app, channels, template };
}
