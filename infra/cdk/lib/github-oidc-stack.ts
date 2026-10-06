import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

interface Props extends StackProps {
  repo: string; // owner/name
  environments: string[]; // GitHub environments that get a deploy role, e.g. ['dev'] in the dev account
  /** An account can hold only one GitHub OIDC provider. Pass its ARN if another stack or a person already created it. */
  existingProviderArn?: string;
}

const HOST = 'token.actions.githubusercontent.com';
const QUALIFIER = 'hnb659fds'; // the default CDK bootstrap qualifier
const BOOTSTRAP_ROLES = ['deploy', 'file-publishing', 'image-publishing', 'lookup'] as const;

/**
 * GitHub Actions -> AWS without long-lived keys (owner: P2). Deploy once by hand per account:
 *   cdk deploy ai1145-github-oidc -c repo=<owner>/<repo> -c environments=dev
 * One role per GitHub environment. The trust policy matches the exact subject
 * `repo:<repo>:environment:<env>` and audience `sts.amazonaws.com`, so only jobs that run in that
 * protected environment can assume it. Each role can only hop into the CDK bootstrap roles; those
 * roles (and CloudFormation) do the actual deploying.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/.test(props.repo)) {
      throw new Error(`repo must be owner/name without wildcards, got "${props.repo}"`);
    }
    for (const env of props.environments) {
      if (!/^[a-z][a-z0-9-]*$/.test(env)) throw new Error(`environment names must be plain lowercase words, got "${env}"`);
    }

    const providerArn = props.existingProviderArn
      ?? new iam.OpenIdConnectProvider(this, 'GitHub', { url: `https://${HOST}`, clientIds: ['sts.amazonaws.com'] }).openIdConnectProviderArn;

    for (const env of props.environments) {
      const role = new iam.Role(this, `Deploy-${env}`, {
        roleName: `ai1145-gha-deploy-${env}`,
        description: `GitHub Actions deploys for the ${env} environment (OIDC, no stored keys)`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${HOST}:aud`]: 'sts.amazonaws.com',
            [`${HOST}:sub`]: `repo:${props.repo}:environment:${env}`,
          },
        }),
      });
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: BOOTSTRAP_ROLES.map((r) => `arn:${this.partition}:iam::${this.account}:role/cdk-${QUALIFIER}-${r}-role-${this.account}-${this.region}`),
      }));
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'ReadBootstrapVersion',
        actions: ['ssm:GetParameter'],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${QUALIFIER}/version`],
      }));
      new CfnOutput(this, `DeployRoleArn${env}`, {
        value: role.roleArn,
        description: `Store as the GitHub repo variable AWS_${env.toUpperCase()}_DEPLOY_ROLE_ARN`,
      });
    }
  }
}
