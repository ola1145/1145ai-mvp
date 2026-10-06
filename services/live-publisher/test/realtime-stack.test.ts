import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// aws-cdk-lib is a dependency of infra/cdk, not of this package: resolve it from there (same instance the stack uses).
const CDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../infra/cdk');
const cdkRequire = createRequire(path.join(CDK_DIR, 'package.json'));
interface TemplateLike { hasResourceProperties(type: string, props: unknown): void; toJSON(): unknown }
const { App } = cdkRequire('aws-cdk-lib') as { App: new (props?: unknown) => never };
const { Match, Template } = cdkRequire('aws-cdk-lib/assertions') as {
  Match: { stringLikeRegexp(p: string): unknown; arrayWith(a: unknown[]): unknown };
  Template: { fromStack(stack: unknown): TemplateLike };
};

// infra/cdk/lib/paths.ts resolves the repo root from process.cwd() at import time (cdk runs from infra/cdk).
const prevCwd = process.cwd();
process.chdir(CDK_DIR);
const { onSubscribeCode, RealtimeStack } = await import('../../../infra/cdk/lib/realtime-stack.js');
const { AuthStack } = await import('../../../infra/cdk/lib/auth-stack.js');
const { DataStack } = await import('../../../infra/cdk/lib/data-stack.js');
const { EventsStack } = await import('../../../infra/cdk/lib/events-stack.js');
process.chdir(prevCwd);

/**
 * Runs the real AppSync onSubscribe handler source against fake contexts. The AppSync JS runtime is not available
 * here, so we strip the import and inject a `util` whose unauthorized() throws.
 */
function runOnSubscribe(code: string, ctx: unknown): 'allowed' | 'denied' {
  const body = code.replace(/^\s*import .*$/m, '').replace(/export function onSubscribe/, 'function onSubscribe');
  const util = { unauthorized: () => { throw new Error('UNAUTHORIZED'); } };
  const fn = new Function('util', `${body}; return onSubscribe;`)(util) as (c: unknown) => unknown;
  try { fn(ctx); return 'allowed'; } catch (e) { if ((e as Error).message === 'UNAUTHORIZED') return 'denied'; throw e; }
}
const sub = (channelPath: string, claims: Record<string, unknown> | null) => ({ identity: claims ? { claims } : null, info: { channel: { path: channelPath } } });

describe('tenants namespace onSubscribe', () => {
  const code = onSubscribeCode({ namespace: 'tenants', suffix: 'live', claim: 'custom:tenant_id' });
  const A = { 'custom:tenant_id': 't_tenanta01', sub: 'owner-a' };
  it('allows a member of the tenant', () => expect(runOnSubscribe(code, sub('/tenants/t_tenanta01/live', A))).toBe('allowed'));
  it('denies owner A subscribing to tenant B', () => expect(runOnSubscribe(code, sub('/tenants/t_tenantb01/live', A))).toBe('denied'));
  it('denies wildcards and other suffixes', () => {
    for (const p of ['/tenants/*', '/tenants/t_tenanta01/*', '/tenants/t_tenanta01/other', '/tenants/t_tenanta01/live/x', '/tenants/t_tenanta01', '/tenants//live']) {
      expect(runOnSubscribe(code, sub(p, A))).toBe('denied');
    }
  });
  it('denies callers with no tenant claim or no identity', () => {
    expect(runOnSubscribe(code, sub('/tenants/t_tenanta01/live', { sub: 'x' }))).toBe('denied');
    expect(runOnSubscribe(code, sub('/tenants/undefined/live', { sub: 'x' }))).toBe('denied');
    expect(runOnSubscribe(code, sub('/tenants/t_tenanta01/live', null))).toBe('denied');
  });
});

describe('owners namespace onSubscribe', () => {
  const code = onSubscribeCode({ namespace: 'owners', suffix: 'chat', claim: 'sub' });
  it('allows the owner', () => expect(runOnSubscribe(code, sub('/owners/sub-a/chat', { sub: 'sub-a' }))).toBe('allowed'));
  it('denies owner A on owner B chat, wildcard, and other suffix', () => {
    for (const p of ['/owners/sub-b/chat', '/owners/*', '/owners/sub-a/*', '/owners/sub-a/other', '/owners/sub-a/chat/x']) {
      expect(runOnSubscribe(code, sub(p, { sub: 'sub-a' }))).toBe('denied');
    }
  });
  it('a tenant-mate of the owner cannot read the owner chat', () => {
    expect(runOnSubscribe(code, sub('/owners/sub-a/chat', { sub: 'sub-staff', 'custom:tenant_id': 't_tenanta01' }))).toBe('denied');
  });
});

describe('ops namespace onSubscribe', () => {
  const code = onSubscribeCode({ namespace: 'ops', suffix: 'fleet', group: 'ops' });
  it('allows the ops group only', () => {
    expect(runOnSubscribe(code, sub('/ops/fleet', { 'cognito:groups': ['ops'] }))).toBe('allowed');
    expect(runOnSubscribe(code, sub('/ops/fleet', { 'cognito:groups': ['staff'], 'custom:tenant_id': 't_tenanta01' }))).toBe('denied');
    expect(runOnSubscribe(code, sub('/ops/fleet', { sub: 'x' }))).toBe('denied');
    expect(runOnSubscribe(code, sub('/ops/other', { 'cognito:groups': ['ops'] }))).toBe('denied');
  });
});

describe('RealtimeStack template', () => {
  let t: TemplateLike;
  beforeAll(() => {
    // Skip real esbuild bundling in unit tests.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-east-1' };
    const data = new DataStack(app, 'ai1145-test-data', { env });
    const events = new EventsStack(app, 'ai1145-test-events', { env });
    const auth = new AuthStack(app, 'ai1145-test-auth', { env, data, stage: 'test' });
    t = Template.fromStack(new RealtimeStack(app, 'ai1145-test-realtime', { env, auth, events }));
  }, 60_000);

  it('subscribes with Cognito only and publishes with IAM only, per namespace', () => {
    for (const ns of ['tenants', 'owners', 'ops']) {
      t.hasResourceProperties('AWS::AppSync::ChannelNamespace', {
        Name: ns,
        PublishAuthModes: [{ AuthType: 'AWS_IAM' }],
        SubscribeAuthModes: [{ AuthType: 'AMAZON_COGNITO_USER_POOLS' }],
        CodeHandlers: Match.stringLikeRegexp('onSubscribe'),
      });
    }
  });

  it('routes the live event types (including fleet state) to the publisher', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { 'detail-type': Match.arrayWith(['booking.created', 'conversation.message', 'tenant.state_changed']) },
    });
  });

  it('gives the publisher publish rights only, never subscribe or wildcard', () => {
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('appsync:EventPublish');
    expect(json).not.toContain('appsync:EventSubscribe');
    expect(json).not.toContain('"appsync:*"');
  });
});
