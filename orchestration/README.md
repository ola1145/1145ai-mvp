# Orchestration

```
orchestration/issues.ts  ──► pnpm orchestrate:briefs     ──► tasks/<ID>.md (generated)
        │                ──► pnpm orchestrate:bootstrap  ──► Linear project + 53 issues
        │                                                    ├─ assigned to Devin   → Devin starts (Linear integration)
        │                                                    ├─ assigned to Cursor  → background agent on Grok
        │                                                    ├─ agent:claude        → /dispatch-claude (worktree subagents)
        │                                                    └─ agent:human         → you (E8 spike, U1 UI)
        └────────────────── CI ownership check (PR tag [1145:ID] → Owns list)
pnpm orchestrate:dispatch  → API fallback for Devin / Cursor if a Linear trigger didn't fire
```

Agent mix: 15 Devin, 22 Cursor-on-Grok, 14 Claude, 2 human (53 total; 51 agent issues run at once).
`orchestration/test/ownership.test.ts` guarantees no two issues own the same file.

Prompts: `prompts/claude-orchestrator.md` (paste into Claude Code or `/orchestrate`), `prompts/devin-playbook.md`
(Devin Playbooks), `prompts/cursor-grok.md` (Cursor background agents).

Verify before first use: Linear integration user names (`LINEAR_DEVIN_USER`, `LINEAR_CURSOR_USER`), Devin's trigger
label (`DEVIN_TRIGGER_LABEL`), and the Devin/Cursor API endpoints used in `dispatch.ts`.
