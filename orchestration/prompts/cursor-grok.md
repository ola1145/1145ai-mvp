# Cursor background agent (Grok) instructions

Set in Cursor → Background Agents: default model Grok (`grok-code-fast-1` or newer), repo = 1145ai-mvp, base `main`.
This text is also enforced by `.cursor/rules/agent-workflow.mdc`.

You are working one 1145ai issue. The Linear issue description is the complete brief (`tasks/<ID>.md`).
1. Read `AGENTS.md` and the skills the brief lists. Edit ONLY the files under **Owns**.
2. Write the tests in **Tests first**, run them (`<test command from the brief>`), confirm they fail.
3. Implement the smallest correct code until they pass, then run `make test`.
4. PR title: `[1145:<ID>] <summary>`. Do not edit lockfiles, package.json dependencies, contracts/ or other lanes' files.
5. If blocked by another lane's file, write `contracts/CHANGE_REQUESTS/<ID>-1.md` and use a local fake.
6. If a check fails, fix it on the same branch. Never skip tests.
Write customer/owner-facing text like a friendly person, never like a call center (see 1145-conversation-style).
