# Implementation plan — one parallel burst

Everything except the UI runs at the same time. The contracts and the skeleton (every handler, step and stack
already exists as a typed stub with its owner) are what make that safe.

```
Phase 0  (orchestrator, ~1 hour)   lockfile · MCP · skills · secrets · GitHub rulesets · Linear project
Phase 1  (all 51 agent issues at once)  Devin 15 · Claude 14 · Cursor+Grok 22      UI: you, in parallel
Phase 2  (continuous)              every green PR auto-merges → deploys to dev → e2e smoke
Phase 3  (gates)                   Gate E2E scenario green in dev → prod promote (your approval) → friendly tenants
```

Source of truth for the work: `orchestration/issues.ts` (rendered to `tasks/*.md` and to Linear).
Each issue owns specific files; `orchestration/test/ownership.test.ts` fails if two issues own the same path.

## Why nothing waits
- Contracts are frozen at v0.1 and owned by one steward (C0); changes go through `contracts/CHANGE_REQUESTS/`.
- Every Lambda handler, workflow step, worker module and CDK stack already exists, wired into infra, as a stub.
- Dependencies are pre-declared; the lockfile has one owner (P3), so 50 PRs never fight over it.
- Lanes test against fakes; integration happens continuously in dev after each merge.
- The only human-gated work: the real-call latency spike (E8) and the UI.

## Gate: end-to-end in dev (automated by P8)
Friend link → web chat → Google sign-in → basics → card on file → number bought → facts confirmed → agent named →
smoke call answered → second phone calls the DID and books → owner gets a Telegram notification and sees it live →
owner asks the copilot "what's booked tomorrow?" → transcript, summary, usage recorded → style checks pass on every turn.

## Definition of done (every issue)
Tests in "Tests first" written first and passing · `make test` green · touched only owned paths · PR title tagged
`[1145:<ID>]` · Claude review APPROVE · conversation-style checks pass for any agent-facing text.
