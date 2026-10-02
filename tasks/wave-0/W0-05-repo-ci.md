# W0-05 · Repo, CI, CDK bootstrap
**Agent:** infra-cdk · **Branch:** lane/infra

## Owns
`.github/**`, `infra/cdk/**`, `Makefile`, root `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`

## Steps
1. `pnpm install` produces `pnpm-lock.yaml`; commit it (CDK bundling needs it).
2. CI (`.github/workflows/ci.yml`): typecheck, vitest, pytest for `engines/livekit-agent` and `agents`, `cdk synth`.
3. GitHub OIDC role in the dev account; a manual `deploy-dev` workflow with environment approval.
4. `cdk bootstrap` dev (you run it).

## Acceptance
- CI green on main; `cdk synth` produces all six stacks; no deploy without approval.

## Status
- state: TODO
