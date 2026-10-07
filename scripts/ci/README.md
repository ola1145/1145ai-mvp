# scripts/ci

Checks behind the required status checks. Each prints one actionable line per failure.

**The merge-deciding checks run from the base commit.** `ownership`, `contracts-guard`, `secrets-scan` and `main-green`
check out the PR's base commit as the workspace and the PR head under `pr/`, then run `../node_modules/.bin/tsx
../scripts/ci/<script>` with `working-directory: pr`. The script and `orchestration/issues.ts` therefore come from the
base: a PR that edits either one is judged by the old copy (SEC-01). The first PR that adds a new script is the one
exception, and `/scripts/ci/` is in CODEOWNERS for that reason.

| Script | Check | Notes |
|---|---|---|
| `check-ownership.ts ownership` | ownership | changed files vs the `[1145:<ID>]` owns list; uses `--no-renames` so a move shows both paths |
| `check-ownership.ts contracts` | contracts-guard | `contracts/` or `packages/shared/` needs the `contract-change` label |
| `check-style.ts` | conversation-style | robotic phrasing in copy and goldens |
| `main-green.sh` | main-green | latest success/failure run of ci on main; cancelled runs are ignored; `fix-main` PRs are exempt |
| `route-agent.sh` | ci-failure-router | `devin/*` -> Devin, `cursor/*` -> @cursor, `claude/*` -> @claude; author login is the fallback |
| `sanitize-log.sh` | ci-failure-router | defuses `@mentions` in quoted logs |
| `review-verdict.sh` | claude-review | verdict = first line of the latest `claude[bot]` comment from this run: `Merge gate: APPROVE` or `Merge gate: BLOCK: ...`; no comment fails closed |
| `check-secrets.ts` | secrets-scan | lines a PR adds: provider key shapes and random-looking literals on secret-ish names (HMAC keys, webhook secrets, service tokens that trufflehog cannot verify). Test fixtures and docs are allowlisted by path, one line by `allowlist-secret: <reason>`; private keys, live Stripe keys and AWS key ids never are |
| `check-workflows.ts` | secrets-scan | every workflow: actions pinned to a commit SHA, no `allowed_bots: "*"`, no PR title/body/comment/branch text inside `run:` or a prompt, a top-level `permissions:` block. `make lint-workflows` runs it locally |
| `dep-batch.ts` | none | `pnpm exec tsx scripts/ci/dep-batch.ts` prints today's dependency requests for P3's single lockfile PR |

## Asking P3 for a dependency

Lanes never edit lockfiles or dependency lists. Write `contracts/CHANGE_REQUESTS/<ID>-<n>.md`:

```
Kind: dependency
- npm: `zod@^3.23.0` in services/tool-api
- uv: `httpx>=0.27` in engines/livekit-agent
```

P3 batches these once a day, updates `pnpm-lock.yaml` and `uv.lock` in one PR, and deletes nothing: the request
files stay as the record.
