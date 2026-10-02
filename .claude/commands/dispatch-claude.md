---
description: Launch every open Claude-owned issue as a worktree-isolated subagent, all in parallel
---
1. List issues with `agent: 'claude'` in `orchestration/issues.ts` whose Linear status is not Done (Linear MCP).
2. Map each to its subagent: C0 contracts-architect · P3 ci-engineer · T0,T2 tool-api-builder · C1 channels-builder ·
   D2 provisioning-builder · D7,E4,A2,A3 conversation-designer · E5 voice-livekit-builder · A4 test-engineer ·
   G1 postcall-builder · Q2 security-auditor.
3. Launch them all at once with the Task tool. Prompt each: "Work [1145:<ID>]. Brief: tasks/<ID>.md."
4. As each returns, move its Linear issue to In Review with the PR link. Re-launch any that failed with the error.
