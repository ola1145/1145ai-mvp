# Floor status (maintained by the orchestrator)

Last update: 2026-10-03 · Phase 0 in progress (cloud session, branch `claude/bold-mendel-btjun0`)

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

## Floor

| Issue | Agent | State | PR | Checks | Blocker |
|---|---|---|---|---|---|
| all | — | Phase 1 not started | — | — | two repo secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `AUTOMERGE_PAT`) so `verify.sh` passes |
