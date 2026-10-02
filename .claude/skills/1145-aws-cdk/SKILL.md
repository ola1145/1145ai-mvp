---
name: 1145-aws-cdk
description: Conventions for the 1145ai AWS CDK app — one stack per owning lane, nodeFn bundling helper, ABAC tenant policies, route tables mirroring OpenAPI, OIDC deploys, and assertion tests. Use whenever you edit infra/cdk, add a Lambda or route, change IAM, or touch deploy workflows.
---

# CDK conventions

- One stack per lane (see `orchestration/issues.ts` owners). `bin/app.ts` already wires every stack; don't add
  cross-lane edits there.
- Lambdas: `nodeFn(scope, id, 'services/<svc>/src/<file>.ts', { env })` from `lib/lambda.ts` (ESM, ARM64, Node 22,
  bundled from the repo root so `@1145/shared` resolves).
- Tenant data permissions only through `DataStack.tenantDataRole` (LeadingKeys + S3 prefix by `aws:PrincipalTag/tenant_id`).
  Route items (`NUMBER#`, `IDENTITY#`, …) via `data.grantRouteRead(fn)`. No unconditioned `dynamodb:*`.
- Stack names start with a letter: `ai1145-<stage>-<name>`.
- Verify locally: `make synth` (needs pnpm-lock.yaml). Add assertion tests in `infra/cdk/test` (P4 owns the folder;
  others request via change request).
- Deploys happen only in GitHub Actions via OIDC roles from `GithubOidcStack`. Never `cdk deploy` from an agent.
