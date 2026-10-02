# Floor status (maintained by the orchestrator)

Last update: 2026-10-02 · Phase 0 in progress

## Phase 0 checklist

| Step | State | Notes |
|---|---|---|
| 0.1 Toolchain | done | node v26.0.0 (repo targets 22), pnpm 9.12.0, uv 0.11.31, gh (ola1145), docker 29.6.1 installed but daemon not running, `.env` present |
| 0.2 Baseline | green locally, not committed | `make test` 73 TS + 12 Py pass, `make typecheck` pass, `make synth` pass after adding `esbuild@0.28.2` to root devDependencies. Lockfiles created (pnpm-lock.yaml, two uv.lock). Not committed: local folder is not a git repo |
| 0.3 MCP | blocked on approval | context7 and livekit-docs connect. linear, github, aws-knowledge, stripe are "Pending approval". github (empty `GITHUB_MCP_PAT`) and stripe (empty `STRIPE_MCP_TEST_KEY`) will fail auth until keys exist |
| 0.4 Skills | partial | all nine `1145-*` skills are listed and load. Subagent trigger tests not run yet |
| 0.5 Secrets | waiting | see "Secrets" below |
| 0.6 GitHub | blocked | needs git repo plus `GH_ADMIN_TOKEN` |
| 0.7 Linear | blocked | needs `LINEAR_API_KEY` |

## Secrets (names only)

Set in `.env`: `AWS_REGION`, `CURSOR_AGENT_MODEL`, `GITHUB_REPO_URL`, `LINEAR_TEAM_KEY`, `RESOLVER_MODE`, `STATIC_TENANT_JSON`, one `LIVEKIT_API_KEY` and one `LIVEKIT_API_SECRET` line.
Empty: every other variable in `docs/API_KEYS.md`. `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` also appear a second time as empty lines, which can override the set value depending on the loader.

## Floor

| Issue | Agent | State | PR | Checks | Blocker |
|---|---|---|---|---|---|
| — | — | Phase 1 not started | — | — | Phase 0 gates above |
