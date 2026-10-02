# 1145ai MVP — AI front desk for small business

Monorepo for the 1145ai MVP: viral owner onboarding (web chat / Telegram), a per-tenant
customer agent (voice + web chat), an owner-only admin agent, the tenant tool API, and a thin
1145 control plane.

**Status:** scaffold complete; ready for Phase 0. No third-party approvals anywhere in the MVP (ADR-0005).

Scaffold health: 73 TypeScript + 12 Python unit tests pass · TypeScript and CDK typecheck clean · 13 stacks synthesize ·
workflows pass actionlint · 53 issues with zero file-ownership overlap.

## Start the build
1. Fill `.env` from `.env.example` (key list and where to get each: `docs/API_KEYS.md`).
2. Open Claude Code at the repo root and run `/orchestrate` (prompt: `orchestration/prompts/claude-orchestrator.md`).
   It configures MCP, skills, GitHub rulesets and Linear, then fans out to Devin, Cursor-on-Grok and Claude subagents.
3. Build the UI (`apps/`, issue U1) while the agents work.

## Read in this order
1. `docs/adr/0005-no-third-party-approvals.md` — what the MVP may and may not depend on
2. `docs/01-architecture-review.md` — critique of the "three flows, two engines" design
3. `docs/02-target-architecture.md` — the revised MVP architecture and scope (in / out)
4. `docs/03-implementation-plan.md` — the single parallel burst
5. `docs/04-parallel-agent-workflow.md` — Claude, Devin, Cursor/Grok and how PRs merge
6. `AGENTS.md` — the rules every agent follows

## Layout
```
contracts/        Source of truth: OpenAPI, event schemas, DynamoDB keys, realtime channels (read-only to lanes)
packages/shared/  TS types generated/hand-written from contracts: TenantContext, VoiceEngine, events, keys
services/         TS Lambdas: tool-api, channels (WhatsApp/Telegram ingress + router), provisioning, post-call, control-plane
engines/          Voice engines behind one interface: livekit-agent (Python worker), livekit-adapter, elevenlabs-adapter
agents/           AgentCore agents (Python): onboarding, admin
infra/cdk/        AWS CDK app (TypeScript)
apps/             Tenant app (Flutter) and admin console (React) — built separately, integrate via contracts
orchestration/    issues.ts (53 issues, source of truth), Linear bootstrap, dispatch, agent prompts
tasks/            Generated briefs, one per issue
.claude/          Skills (9), subagents (11), commands, settings; .mcp.json for MCP servers
evals/            Conversation scenarios used as acceptance tests for the agents
```

## Quick start
```bash
make bootstrap   # pnpm install + uv sync
make test        # all unit tests (TS + Python)
make synth       # cdk synth (no deploy; deploys go through CI with approval)
```
