# Parallel agents: how the floor runs

| Agent | Triggered by | Best at | Issues |
|---|---|---|---|
| Claude Code (orchestrator, Opus) | You, `/orchestrate` | Dispatch, review, contracts, merge health | — |
| Claude Code subagents (`isolation: worktree`) | Orchestrator via Task tool, up to 30 at once | Security-sensitive logic, prompts, conversation quality, evals | 14 |
| Devin | Linear assignment / label (API fallback) | Long multi-step work with real environments: CDK, deploys, SIP setup, e2e | 15 |
| Cursor background agents on Grok | Linear assignment to Cursor (API fallback) | Fast, well-scoped handler + test pairs | 22 |
| You | — | UI, the real-call spike, approvals for prod | 2 |

Flow per issue: Linear issue (brief) → agent branch → PR titled `[1145:<ID>] …` → required checks
(types, tests, synth, ownership, contracts guard, conversation style, secret scan, main-green, Claude review) →
auto-merge (squash) → deploy to dev → e2e smoke. Failing checks are routed back to the PR's author agent
automatically (`ci-failure-router.yml`).

Merge safety with 50 concurrent PRs: strict file ownership, no lockfile edits outside P3, contracts frozen,
"main-green" freeze if main breaks, and a merge queue if your GitHub plan has one (CI listens to `merge_group`).
