---
name: 1145-ci-and-prs
description: The 1145ai GitHub pipeline — PR title tags, required checks and what each one catches, auto-merge, main-green merge freeze, failure routing back to Devin/Cursor/Claude, Claude review, deploy-to-dev and prod promotion. Use when opening or fixing a PR, when a check fails, or when editing .github/ or scripts/ci.
---

# PRs and CI

PR title: `[1145:<ID>] <summary>`. The ID ties the PR to its issue and its ownership list.

| Check | Fails when |
|---|---|
| typescript | typecheck or vitest fails |
| python | pytest fails in engines/livekit-agent or agents |
| cdk-synth | any stack fails to synthesize/bundle |
| ownership | a changed file is not owned by the PR's issue |
| contracts-guard | contracts/ or packages/shared changed without the `contract-change` label |
| conversation-style | prompts/eval goldens contain robotic phrasing (`@1145/conversation-style`) |
| secrets-scan | a verified secret appears in the diff |
| main-green | the latest CI run on main failed (merge freeze until main is fixed) |
| claude-review | the security checklist is violated (BLOCK verdict) |

Green PRs auto-merge (squash) via `automerge.yml` using a PAT so the merge triggers deploys. Failing checks are
commented back to the author agent by `ci-failure-router.yml` (Devin reads its PR comments; `@cursor` and
`@claude` mentions trigger fixes). Main → deploy dev → e2e. Prod promotion waits for the owner in the `prod` environment.
