# scripts/ci

Checks behind the required status checks. Each prints one actionable line per failure.

| Script | Check | Notes |
|---|---|---|
| `check-ownership.ts ownership` | ownership | changed files vs the `[1145:<ID>]` owns list; uses `--no-renames` so a move shows both paths |
| `check-ownership.ts contracts` | contracts-guard | `contracts/` or `packages/shared/` needs the `contract-change` label |
| `check-style.ts` | conversation-style | robotic phrasing in copy and goldens |
| `main-green.sh` | main-green | latest success/failure run of ci on main; cancelled runs are ignored; `fix-main` PRs are exempt |
| `route-agent.sh` | ci-failure-router | `devin/*` -> Devin, `cursor/*` -> @cursor, `claude/*` -> @claude; author login is the fallback |
| `sanitize-log.sh` | ci-failure-router | defuses `@mentions` in quoted logs |
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
