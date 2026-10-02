# Running the build as parallel sub-agents

Your tools: Claude Code (Max), Cursor Pro, ralph orchestrator. This repo supports three ways to run lanes. Mix them.

## The model
- **Orchestrator** = you plus one Claude Code session at the repo root on `main` (Opus). It dispatches lanes,
  reviews PRs, merges in order, and owns the gates. It does not write feature code.
- **Lane** = one task brief in `tasks/`, one branch `lane/<id>`, one git worktree, one builder agent.
- **Ownership** = each brief lists the paths it owns. Two lanes never own the same path, so parallel edits do not conflict.
- **Contracts** = the shared language. Lanes read them; only `contracts-architect` writes them. Changes go through
  `contracts/CHANGE_REQUESTS/`.

## Mode 1 · In-session subagents (short tasks, reviews)
In the orchestrator session:
```
/wave 1            # dispatches every Wave 1 brief to its subagent in parallel via the Task tool
/review lane/tool-api
/gate 2            # runs the gate checklist and reports pass/fail per item
```
Subagents are defined in `.claude/agents/`. Use this mode for tasks under ~1 hour and for every review.

## Mode 2 · Worktree per lane (long lanes)
```bash
scripts/new-lane.sh tool-api tasks/wave-1/W1-11-tool-api.md   # creates ../1145-wt/tool-api on lane/tool-api
cd ../1145-wt/tool-api && claude                               # or open the folder in Cursor
> Read CLAUDE.md and tasks/wave-1/W1-11-tool-api.md, then start with the tests.
```
Run up to 4 worktrees at once; more than that and your review bandwidth becomes the bottleneck.

## Mode 3 · Headless loop (ralph-style)
```bash
scripts/run-lane.sh tasks/wave-1/W1-11-tool-api.md 12   # up to 12 iterations
```
Each iteration feeds the brief to `claude -p`, runs the lane's tests, and stops when the brief's Status block
says `DONE` and tests pass. If you prefer ralph orchestrator, point it at the same brief as its prompt file; the
completion condition is identical. Deploys and paid API calls are denied in `.claude/settings.json`.

## Merge order
`contracts` → `infra` → `tool-api` → {`channels`, `provisioning`, `voice-livekit`, `agents`, `post-call`} →
`voice-elevenlabs` → integration. Rebase lanes on `main` after each merge; contracts rarely change after Gate 1.

## Contract change protocol
1. Lane writes `contracts/CHANGE_REQUESTS/<lane>-<n>.md`: the change, the reason, affected lanes.
2. Orchestrator runs `contracts-architect` on it; it updates `contracts/` and `packages/shared/` in one PR.
3. Affected lanes rebase. Breaking changes after Gate 1 need your explicit approval.

## Cursor
`.cursor/rules/1145-core.mdc` mirrors `CLAUDE.md`. Open a lane worktree as its own Cursor window, attach the brief,
and use Agent mode. Keep Claude Code for orchestration and reviews, Cursor for hands-on lanes.

## What you do by hand
Gate approvals · buying the first numbers · Meta/Google/10DLC/Stripe paperwork · deploying to prod ·
listening to the first 50 real calls.
