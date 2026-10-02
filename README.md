# 1145ai MVP — AI front desk for small business

Monorepo for the 1145ai MVP: viral owner onboarding (WhatsApp / Telegram / web), a per-tenant
customer agent (voice + web chat), an owner-only admin agent, the tenant tool API, and a thin
1145 control plane.

**Status: Gate 0 — implementation plan awaiting owner approval. No lane starts before approval.**

Scaffold health: 58 unit tests pass (51 TypeScript, 7 Python); TypeScript and CDK typecheck clean; `cdk synth` produces six stacks.

## Read in this order
1. `docs/01-architecture-review.md` — critique of the "three flows, two engines" design
2. `docs/02-target-architecture.md` — the revised MVP architecture and scope (in / out)
3. `docs/03-implementation-plan.md` — waves, lanes, gates, definition of done
4. `docs/04-parallel-agent-workflow.md` — how to run the lanes in parallel with Claude Code / Cursor / ralph
5. `CLAUDE.md` — the rules every agent (human or AI) follows in this repo

## Layout
```
contracts/        Source of truth: OpenAPI, event schemas, DynamoDB keys, realtime channels (read-only to lanes)
packages/shared/  TS types generated/hand-written from contracts: TenantContext, VoiceEngine, events, keys
services/         TS Lambdas: tool-api, channels (WhatsApp/Telegram ingress + router), provisioning, post-call, control-plane
engines/          Voice engines behind one interface: livekit-agent (Python worker), livekit-adapter, elevenlabs-adapter
agents/           AgentCore agents (Python): onboarding, admin
infra/cdk/        AWS CDK app (TypeScript)
apps/             Tenant app (Flutter) and admin console (React) — built separately, integrate via contracts
tasks/            One brief per task, grouped by wave. Each brief is a runnable prompt for a lane agent
.claude/          Claude Code subagents and slash commands for the parallel workflow
evals/            Conversation scenarios used as acceptance tests for the agents
```

## Quick start
```bash
make bootstrap   # pnpm install + uv sync
make test        # all unit tests (TS + Python)
make synth       # cdk synth (no deploy; deploys go through CI with approval)
```
