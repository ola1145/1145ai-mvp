import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/deploy.yml'), 'utf8');
const job = (name: string) => {
  const start = yml.indexOf(`\n  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('deploy.yml', () => {
  it('uses OIDC only: id-token permission, no stored AWS keys', () => {
    expect(yml).toMatch(/id-token: write/);
    expect(yml).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws-access-key-id|aws-secret-access-key/i);
    expect(yml).not.toMatch(/secrets\.AWS_/);
  });

  it('deploys all stacks to dev on a green main push, within 20 minutes, in the dev environment', () => {
    const dev = job('dev');
    expect(dev).toContain('environment: dev');
    expect(dev).toContain('pnpm cdk deploy --all -c stage=dev');
    expect(dev).toContain('vars.AWS_DEV_DEPLOY_ROLE_ARN');
    expect(dev).toMatch(/timeout-minutes: (?:[1-9]|1\d|20)\b/);
    expect(yml).toMatch(/workflow_run\.conclusion == 'success'/);
    expect(yml).toMatch(/workflow_run\.event == 'push'/);
  });

  it('calls e2e after dev, and prod waits for e2e and the protected prod environment', () => {
    expect(job('e2e')).toMatch(/needs: dev/);
    expect(job('e2e')).toContain('uses: ./.github/workflows/e2e.yml');
    const prod = job('prod');
    expect(prod).toMatch(/needs: e2e/);
    expect(prod).toContain('environment: prod');
    expect(prod).toContain('vars.AWS_PROD_DEPLOY_ROLE_ARN');
    expect(prod).toContain('pnpm cdk deploy --all -c stage=prod');
  });

  it('deploys the commit CI approved in every job', () => {
    expect(yml).toMatch(/DEPLOY_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
    expect(yml.match(/ref: "\$\{\{ env\.DEPLOY_SHA \}\}"/g)).toHaveLength(2);
  });
});
