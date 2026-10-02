import { Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

interface Props extends StackProps { repo: string /* owner/name */; environments: string[] }

/**
 * GitHub Actions -> AWS without long-lived keys (owner: P2). Deploy once by hand per account:
 *   cdk deploy ai1145-github-oidc -c repo=<owner>/<repo>
 * One role per GitHub environment; each can only assume the CDK bootstrap roles.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const provider = new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    for (const env of props.environments) {
      const role = new iam.Role(this, `Deploy-${env}`, {
        roleName: `ai1145-gha-deploy-${env}`,
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.repo}:environment:${env}` },
        }),
      });
      role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`] }));
    }
  }
}
