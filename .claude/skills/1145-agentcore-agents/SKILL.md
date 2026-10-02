---
name: 1145-agentcore-agents
description: Building the 1145ai onboarding agent and owner copilot on Amazon Bedrock AgentCore Runtime with Strands — tool closures bound to router-supplied context, propose-only admin tools, AgentCore Memory session continuity across web chat and Telegram, deployment, and evals. Use for any work in agents/ or the router's AgentCore invocation.
---

# AgentCore agents

- Entry: `BedrockAgentCoreApp` + `@app.entrypoint`; build `strands.Agent` per invocation with tools from
  `make_*_tools(api, ...)`. Tools are plain functions wrapped with `strands.tool` in `app.py` only, so tests run
  without Strands installed.
- Context comes from the payload the router builds: `onboardingId` (onboarding) or `tenantToken` (copilot).
  Never accept ids or tokens as tool parameters (a test enforces this).
- Copilot changes: `propose_*` only. The owner applies with `CONFIRM 1234` (router, deterministic) or the dashboard.
- Session continuity: runtime session id `onb-<onboardingId>` or `admin-<tid>-<channel>-<user>`; AgentCore Memory
  short-term keyed by it. Owner web chat and Telegram for the same onboarding share the session.
- Models: Sonnet for onboarding (rare, high value), Haiku for the copilot (frequent). Record cost per conversation.
- Every reply must pass `1145-conversation-style` (chat). Prompts live in `system_prompt.md` next to each agent.
