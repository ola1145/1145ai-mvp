import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

// Moved here from scripts/secrets/test (contracts/CHANGE_REQUESTS/P2-1.md). The parked copy there can go once this is merged.

const REPO = 'acme/1145ai-mvp';
const ACCOUNT = '111111111111';

function synth(props: { repo?: string; environments?: string[]; existingProviderArn?: string } = {}) {
  const app = new App();
  const stack = new GithubOidcStack(app, 'ai1145-github-oidc', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    repo: props.repo ?? REPO,
    environments: props.environments ?? ['dev', 'prod'],
    existingProviderArn: props.existingProviderArn,
  });
  return Template.fromStack(stack);
}

type Trust = { Statement: { Action: string; Condition: Record<string, Record<string, unknown>> }[] };
// The provider custom resource brings its own Lambda role; only the named deploy roles matter here.
const roles = (t: Template) => (Object.values(t.findResources('AWS::IAM::Role')) as { Properties: { RoleName: string; AssumeRolePolicyDocument: Trust; MaxSessionDuration?: number } }[]).filter((r) => r.Properties.RoleName?.startsWith('ai1145-gha-deploy-'));
const deployPolicies = (t: Template) => Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('Deploy')).map(([, p]) => p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } });

describe('GithubOidcStack', () => {
  it('creates the GitHub OIDC provider with the sts audience', () => {
    synth().hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
  });

  it('trusts only repo:<repo>:environment:<env> with aud sts.amazonaws.com, one role per environment', () => {
    const rs = roles(synth());
    expect(rs.map((r) => r.Properties.RoleName).sort()).toEqual(['ai1145-gha-deploy-dev', 'ai1145-gha-deploy-prod']);
    for (const r of rs) {
      const env = r.Properties.RoleName.replace('ai1145-gha-deploy-', '');
      const [stmt, ...rest] = r.Properties.AssumeRolePolicyDocument.Statement;
      expect(rest).toEqual([]);
      expect(stmt?.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(stmt?.Condition).toEqual({
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${REPO}:environment:${env}`,
        },
      });
    }
  });

  it('never uses wildcards in the trust policy', () => {
    const json = JSON.stringify(roles(synth()).map((r) => r.Properties.AssumeRolePolicyDocument));
    expect(json).not.toContain('StringLike');
    expect(json).not.toMatch(/:sub"?:"?[^"]*\*/);
  });

  it('can only assume the CDK bootstrap roles in its own account and region', () => {
    const t = synth();
    const assume = deployPolicies(t).flatMap((p) => p.Properties.PolicyDocument.Statement).filter((s) => JSON.stringify(s.Action).includes('sts:AssumeRole'));
    expect(assume.length).toBeGreaterThan(0);
    const resources = JSON.stringify(assume.map((s) => s.Resource));
    for (const kind of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
      expect(resources).toContain(`cdk-hnb659fds-${kind}-role-`);
    }
    expect(resources).not.toContain('"*"');
    expect(resources).not.toContain('role/*');
    expect(resources).not.toContain('cdk-hnb659fds-*');
  });

  it('grants nothing beyond assuming bootstrap roles and reading the bootstrap version', () => {
    const actions = deployPolicies(synth()).flatMap((p) => p.Properties.PolicyDocument.Statement).flatMap((s) => [s.Action].flat());
    expect([...new Set(actions)].sort()).toEqual(['ssm:GetParameter', 'sts:AssumeRole']);
  });

  it('keeps sessions short and exports the role ARNs for the repo variables', () => {
    const t = synth();
    for (const r of roles(t)) expect(r.Properties.MaxSessionDuration).toBe(3600);
    t.hasOutput('DeployRoleArndev', Match.anyValue());
    t.hasOutput('DeployRoleArnprod', Match.anyValue());
  });

  it('supports a single-environment account and an existing provider', () => {
    const arn = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
    const t = synth({ environments: ['dev'], existingProviderArn: arn });
    expect(roles(t)).toHaveLength(1);
    expect(Object.keys(t.findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(0);
    expect(JSON.stringify(roles(t)[0]?.Properties.AssumeRolePolicyDocument)).toContain(arn);
  });

  it('rejects a repo that is not owner/name, and unknown environments', () => {
    expect(() => synth({ repo: 'acme' })).toThrow(/owner\/name/);
    expect(() => synth({ repo: 'acme/*' })).toThrow(/owner\/name/);
    expect(() => synth({ environments: ['dev', '*'] })).toThrow(/environment/);
  });
});
