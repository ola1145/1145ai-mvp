# AWS bootstrap and OIDC deploys (owner runbook, P2)

Nothing in this file has been run. Agents never deploy; these are the exact commands for the owner, once per AWS
account. Replace `<OWNER>/<REPO>`, `<DEV_ACCOUNT_ID>` and `<PROD_ACCOUNT_ID>` with your own values. Do not paste
account ids or role ARNs into files in this public repo; repo variables are the place for them.

Assumptions: region `us-east-1`; AWS CLI profiles `ai1145-dev` and `ai1145-prod` (SSO or short-lived, no stored
access keys); `gh` is logged in as a repo admin; you are in the repo root after `pnpm install`.
If dev and prod share one account, use that account's profile for both and pass `-c environments=dev,prod` in step 2.

## 1. Bootstrap CDK (once per account)

Keep the default qualifier (`hnb659fds`). The deploy roles in `GithubOidcStack` are scoped to those role names.

```sh
cd infra/cdk
pnpm cdk bootstrap aws://<DEV_ACCOUNT_ID>/us-east-1  --profile ai1145-dev
pnpm cdk bootstrap aws://<PROD_ACCOUNT_ID>/us-east-1 --profile ai1145-prod
```

The bootstrap's CloudFormation execution role is AdministratorAccess by default. That is acceptable for the MVP
because only the GitHub environments below can reach it. To narrow it later, add
`--cloudformation-execution-policies arn:aws:iam::aws:policy/<your-policy>` and re-run bootstrap.

## 2. Deploy the OIDC stack (once per account, by hand)

One role per GitHub environment, trusting exactly `repo:<OWNER>/<REPO>:environment:<env>` with audience
`sts.amazonaws.com`. Each role can only assume that account's CDK bootstrap roles.

```sh
cd infra/cdk
pnpm cdk deploy ai1145-github-oidc -c repo=<OWNER>/<REPO> -c environments=dev  --profile ai1145-dev
pnpm cdk deploy ai1145-github-oidc -c repo=<OWNER>/<REPO> -c environments=prod --profile ai1145-prod
```

An account can hold only one GitHub OIDC provider. If the second command (or an earlier setup) fails with
"provider already exists", find its ARN and re-run with `-c oidcProviderArn=<ARN>`:

```sh
aws iam list-open-id-connect-providers --profile <profile>
```

## 3. Store the role ARNs as repo variables (variables, not secrets: they are not sensitive)

The stack prints them as outputs `DeployRoleArndev` and `DeployRoleArnprod`.

```sh
DEV_ARN=$(aws cloudformation describe-stacks --stack-name ai1145-github-oidc --profile ai1145-dev \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArndev'].OutputValue" --output text)
PROD_ARN=$(aws cloudformation describe-stacks --stack-name ai1145-github-oidc --profile ai1145-prod \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArnprod'].OutputValue" --output text)
gh variable set AWS_DEV_DEPLOY_ROLE_ARN  --repo <OWNER>/<REPO> --body "$DEV_ARN"
gh variable set AWS_PROD_DEPLOY_ROLE_ARN --repo <OWNER>/<REPO> --body "$PROD_ARN"
```

## 4. GitHub environments

`scripts/github/setup.sh <OWNER>/<REPO>` creates `dev` and a `prod` environment that requires your approval and only
deploys from protected branches. Also keep `dev` to `main` so a branch cannot borrow the dev role:

```sh
gh api -X PUT repos/<OWNER>/<REPO>/environments/dev --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST repos/<OWNER>/<REPO>/environments/dev/deployment-branch-policies -f name=main
```

## 5. Secrets

```sh
cp .env.example .env     # fill in values locally; .env is git-ignored
scripts/secrets/push.sh <OWNER>/<REPO> dev --dry-run   # names only, calls nothing
AWS_PROFILE=ai1145-dev  scripts/secrets/push.sh <OWNER>/<REPO> dev
AWS_PROFILE=ai1145-prod scripts/secrets/push.sh <OWNER>/<REPO> prod
```

GitHub secrets get the build and workflow keys; every runtime key goes into Secrets Manager as `1145/<stage>/runtime`.
Names come from `docs/API_KEYS.md`.

## 6. First deploy

Run the `deploy` workflow once from the Actions tab (workflow_dispatch). Dev deploys automatically, then the e2e
gate runs, then the prod job waits for your approval on the `prod` environment. After that, every green merge to
`main` deploys to dev within 20 minutes (the dev job has a 20 minute timeout).

## Checks

- No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` anywhere in repo secrets or variables.
- `scripts/github/verify.sh <OWNER>/<REPO>` passes.
- A job on another branch or another environment cannot assume the role (the trust policy is an exact match, no
  wildcards; asserted by `scripts/secrets/test/github-oidc-stack.test.ts`).
