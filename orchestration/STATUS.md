# Floor status (maintained by the orchestrator)

Last update: 2026-10-03 · Phase 1 in progress; merging blocked by CI checks (see Blockers) (cloud session, branch `claude/bold-mendel-btjun0`)

## Phase 0 checklist

| Step | State | Notes |
|---|---|---|
| 0.1 Toolchain | done | node v22.22.0, pnpm 9.12.0, uv 0.8.17, gh 2.89.0, docker 29.6.2 (daemon not running), make. `gh` token in this container is rejected (`GH_TOKEN` login failed); GitHub MCP works. No `.env` in this container (names only in `.env.example`). |
| 0.2 Baseline | green | Lockfiles (`pnpm-lock.yaml`, `agents/uv.lock`, `engines/livekit-agent/uv.lock`) are already on `main`, so no `[1145:P3] lock dependencies` PR is needed. `pnpm install --frozen-lockfile`, `make test` (TS + 7 + 9 Python), `make typecheck`, `make synth` all pass. |
| 0.3 MCP | partial | In this container the repo `.mcp.json` servers (linear, context7, livekit-docs) fail with a proxy 403, so they cannot be checked here. Claude.ai connectors answer: Linear (list teams/projects/users/issues) and GitHub (get repo, PRs, branches). `aws-knowledge` has a connector equivalent. Stripe MCP needs `STRIPE_MCP_TEST_KEY`; GitHub MCP in `.mcp.json` needs `GITHUB_MCP_PAT`. Nothing dropped yet; decide after a run on your machine. |
| 0.4 Skills | partial | Nine `1145-*` skills load. Subagent trigger tests not run yet. |
| 0.5 Secrets | blocked | Owner ran `push.sh` on 2026-10-03; it stopped at `.env` line 63, a bare Linear connect URL that bash tries to execute while sourcing. Fix: comment the line out, re-run. `CLAUDE_CODE_OAUTH_TOKEN` and `AUTOMERGE_PAT` repo secrets still missing. |
| 0.6 GitHub | mostly done | Owner ran `setup.sh` (ok). `verify.sh`: auto-merge, delete-branch, squash-only, required checks, prod reviewers all ok. Failing only on the two secrets above. |
| 0.7 Linear | partly done, needs a decision | Project "1145ai MVP" exists with 53 issues, and the Devin and Cursor users exist in the workspace (integrations installed). **14 issues were marked Done with no work behind them (reset to Backlog on 2026-10-03)** (see below). |

## Linear anomaly (needs owner decision)

C0, P1–P8, T0–T4 (14 issues, not 16 as first reported) were in state Done, but GitHub has zero PRs and one branch. The P3 issue history shows a Cursor run on 2026-10-03 00:52 UTC walking it Backlog → Todo → In Progress → Done as an "MCP completion-status test". Those 14 were test artifacts, not delivered work, and the owner approved resetting them to Backlog; all 53 issues are now Backlog.

## Floor (PRs on ola1145/1145ai-mvp)

All 28 Claude-lane issues have a PR in review: G1 #1, T0 #2, D2 #3, T2 #4, P3 #5, E5 #6, A3 #7, E2 #8, C1 #9, E3 #10, A2 #11, A4 #12, A1 #13, D7 #14, E4 #15, P8 #16, P7 #17, P6 #19, Q1 #20, C0 #21 (contract-change), D5 #22, T7 #23, P2 #24, C6 #25, H2 #26, P5 #27, E1 #29 and the E1 synth fix #28 (fix-main). H3 #18 was opened by a Cursor agent. Q2 (threat model) is deliberately not a PR: see Blockers.

| Agent | Issues | State |
|---|---|---|
| Claude (subagents) | 28 (14 original + 14 that replace Devin) | PRs open, none merged |
| Devin | 0 | daily subscription exceeded; its 15 issues went to Claude |
| Cursor/Grok | 22 | blocked: account not linked; H3 produced PR #18; other 21 in Backlog |
| Human | E8, U1 | not started |

## Blockers

1. **Nothing can merge.** Required checks `cdk-synth` (main red: voice-stack AZ lookup; fix in #28), `main-green` (main red; `fix-main` label exempts the fix PR) and `claude-review` (claude-code-action refuses PRs that edit `claude-review.yml`, so P3's #5 needs a one-time admin merge). Ruleset has no bypass actors.
2. **Q2 threat model** (branch `claude/1145-q2`, public) lists unfixed holes in a public repo: SEC-01 ownership checker can be changed by the PR it checks; SEC-02 claude workflows accept any bot and paste the PR title into the prompt. Owner to decide: delete branch, fix first, or go private.
3. **Cursor monitor agent** in the owner account marks issues Done without work; stop it and link the account at https://cursor.com/linear.
4. Merge-order hazards: A4 #12 tightens the shared style checker; E5 #6 changes livekit pins without refreshing uv.lock while P3 #5 enforces `uv run --locked`.
