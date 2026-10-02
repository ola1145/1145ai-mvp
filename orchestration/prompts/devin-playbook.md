# Devin playbook: 1145ai lane

Paste into Devin → Playbooks as "1145ai lane"; attach it to the Linear trigger. Add the repo's `AGENTS.md` and
`.claude/skills/*/SKILL.md` to Devin's Knowledge.

## Procedure
1. Open the Linear issue; its description is the full brief (also in `tasks/<ID>.md`). Note the **Owns** list.
2. Read `AGENTS.md` and each skill the brief lists (`.claude/skills/<name>/SKILL.md`).
3. `pnpm install --frozen-lockfile`; `make test` must be green before you change anything.
4. Write the **Tests first** items; run them red. Implement until the brief's test command and `make test` pass.
5. Open a PR titled `[1145:<ID>] <summary>`. Put the Linear issue URL in the body.
6. Watch the PR checks. Fix failures yourself; read comments posted by `ci-failure-router`.
7. When the PR auto-merges, move the Linear issue to Done with a two-line summary.

## Specifications
- Only files under **Owns** may change (the `ownership` check enforces this).
- Never edit lockfiles or dependency lists; request via `contracts/CHANGE_REQUESTS/<ID>-<n>.md`.
- Never deploy, buy numbers, send messages, or place calls except where the brief explicitly says to with the
  owner's provided dev credentials (E1, P2, D5 dev runs). Use spend limits.
- No WhatsApp, SMS, Calendar scopes, SES production or app-store dependencies (ADR-0005).
- Anything a customer or owner reads or hears must pass `@1145/conversation-style` and sound like a person.

## Forbidden actions
Force-push to main · merging your own PR · disabling or skipping tests · printing secrets.
