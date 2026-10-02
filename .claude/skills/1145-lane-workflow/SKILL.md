---
name: 1145-lane-workflow
description: How to execute one 1145ai issue as a parallel lane — read the brief, stay inside owned paths, test first, open a correctly tagged PR, handle CI and change requests. Use this at the start of ANY coding task in the 1145ai repo, whenever you are given a [1145:ID] issue, a tasks/*.md brief, or a Linear issue from the 1145ai MVP project, even if the task looks small.
---

# Working a 1145ai lane

About 50 agents (Claude subagents, Devin, Cursor on Grok) build this repo at the same time. The only reason that
works is that every issue owns a disjoint set of files and talks to other lanes through contracts. Breaking either
rule creates merge conflicts or silent integration bugs for everyone else.

## Loop
1. Read `AGENTS.md`, your brief (`tasks/<ID>.md` or the Linear issue), and the skills it lists.
2. Branch from `main`. Any name works; the PR title is what matters: `[1145:<ID>] <short summary>`.
3. Write the brief's **Tests first** items. Run them and watch them fail for the right reason.
4. Implement until the brief's test command and `make test` pass.
5. Open the PR. Required checks: typescript, python, cdk-synth, ownership, contracts-guard, conversation-style,
   secrets-scan, main-green, claude-review. Green PRs auto-merge (squash).
6. If a check fails, read the failing job log, fix, push. Don't disable tests or widen ownership.
7. Update the Linear issue: PR link, what's done, what's stubbed.

## Boundaries
- Edit only paths under **Owns**. If you need someone else's file changed, write
  `contracts/CHANGE_REQUESTS/<ID>-<n>.md` (what, why, exact proposed change), comment on the Linear issue, and keep
  working against a local fake in your own test file.
- Never edit `pnpm-lock.yaml`, `uv.lock` or dependency lists. All dependencies are pre-declared; request new ones
  through a change request to P3.
- Never deploy, buy numbers, send real messages or place real calls. CI deploys to dev after merge.
- No third-party approvals: never introduce WhatsApp, SMS/10DLC, Calendar scopes, SES production access or
  app-store dependencies (ADR-0005).

## Done means
Tests from the brief exist and pass · `make test` green · only owned files changed · any customer- or owner-facing
text passes the `1145-conversation-style` rules · PR tagged and green.
