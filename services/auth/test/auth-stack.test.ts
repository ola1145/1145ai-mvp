import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// aws-cdk-lib is a dependency of infra/cdk only (pnpm is strict), so resolve it from there.
const cdkRequire = createRequire(path.join(root, 'infra/cdk/package.json'));
// Minimal local types: the real ones are not resolvable from this package.
type Resource = { Properties: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Template {
  findResources(type: string): Record<string, Resource>;
  hasResourceProperties(type: string, props: unknown): void;
}
const App = cdkRequire('aws-cdk-lib').App as new () => never;
const { Match, Template: TemplateCls } = cdkRequire('aws-cdk-lib/assertions') as {
  Match: { arrayWith(v: unknown[]): unknown; arrayEquals(v: unknown[]): unknown; anyValue(): unknown };
  Template: { fromStack(s: unknown): Template };
};
let dev: Template;
let prod: Template;

// paths.ts resolves the repo root from cwd (cdk runs inside infra/cdk), so import the stacks after changing into it.
async function build(stageName: string): Promise<Template> {
  const { DataStack } = await import('../../../infra/cdk/lib/data-stack.js');
  const { AuthStack } = await import('../../../infra/cdk/lib/auth-stack.js');
  const app = new App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const data = new DataStack(app, `ai1145-${stageName}-data`, { env });
  return TemplateCls.fromStack(new AuthStack(app, `ai1145-${stageName}-auth`, { env, data, stage: stageName }));
}

beforeAll(async () => {
  process.chdir(path.join(root, 'infra/cdk'));
  dev = await build('dev');
  prod = await build('prod');
}, 120_000);

function google(t: Template) {
  const [idp] = Object.values(t.findResources('AWS::Cognito::UserPoolIdentityProvider'));
  if (!idp) throw new Error("no identity provider");
  return idp.Properties;
}

describe('AuthStack', () => {
  it('adds Google with openid email profile only and credentials from Secrets Manager', () => {
    const p = google(dev);
    expect(p.ProviderType).toBe('Google');
    expect(p.ProviderDetails.authorize_scopes).toBe('openid email profile');
    expect(JSON.stringify(p.ProviderDetails.client_secret)).toContain('resolve:secretsmanager');
    expect(JSON.stringify(p.ProviderDetails.client_id)).toContain('resolve:secretsmanager');
  });

  it('never maps Google data onto custom attributes', () => {
    expect(JSON.stringify(google(dev).AttributeMapping)).not.toContain('custom:');
  });

  it('keeps tenant_id and role out of the client write attributes and only allows Google', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      SupportedIdentityProviders: ['Google'],
      AllowedOAuthScopes: Match.arrayEquals(['openid', 'email', 'profile']),
      AllowedOAuthFlows: ['code'],
      WriteAttributes: ['email'],
      ReadAttributes: Match.arrayWith(['custom:role', 'custom:tenant_id']),
    });
  });

  it('has the hosted UI domain per stage and callbacks for the owner PWA and localhost', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'ai1145-dev' });
    dev.hasResourceProperties('AWS::Cognito::UserPoolClient', { CallbackURLs: ['https://app.dev.1145.ai/auth/callback', 'http://localhost:3000/auth/callback'] });
    prod.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'ai1145-prod' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolClient', { CallbackURLs: ['https://app.1145.ai/auth/callback', 'http://localhost:3000/auth/callback'] });
  });

  it('wires the pre-token trigger and keeps self sign-up off', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreTokenGeneration: Match.anyValue() },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('limits the trigger to MEMBER# index reads and profile reads, always with a LeadingKeys condition', () => {
    const policies = Object.values(dev.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((p: Resource) => p.Properties.PolicyDocument.Statement as { Action: string | string[]; Condition?: unknown }[]);
    const ddb = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith('dynamodb:')));
    expect(ddb.length).toBeGreaterThan(0);
    for (const s of ddb) {
      expect(s.Condition, JSON.stringify(s)).toBeDefined();
      for (const a of [s.Action].flat()) expect(['dynamodb:Query', 'dynamodb:GetItem']).toContain(a);
    }
    expect(JSON.stringify(ddb)).toContain('MEMBER#*');
  });
});
