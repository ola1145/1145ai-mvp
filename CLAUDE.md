# Rules for every agent working in this repo

You are one lane in a parallel build. Other agents are editing other directories at the same time.

## The one rule
Every tool call and every data access carries a `tenantId` that comes from an authenticated source:
the dialed number (voice), a verified channel identity (WhatsApp/Telegram), a Cognito session (dashboard),
or a signed service token. **Never from model output, never from a prompt, never from a request body field
the model filled.** Code that reads `tenantId` from an LLM tool argument is a bug and fails review.

## Ownership
- Only edit paths your task brief lists under **Owns**. Everything else is read-only to you.
- `contracts/` is read-only to every lane except `contracts-architect`. Need a change? Write
  `contracts/CHANGE_REQUESTS/<lane>-<n>.md` (what, why, who is affected) and stop that thread of work.
- `packages/shared/` follows `contracts/`. Only `contracts-architect` edits it.

## How you work
1. Read your task brief in `tasks/`, then the contracts it references.
2. Write the tests listed under **Tests first** before the implementation. Run them; watch them fail.
3. Implement until `make test` passes for your package. Keep functions pure where you can.
4. Update the brief's **Status** block (what is done, what is stubbed, open questions). Do not mark a task
   done with failing tests or untested TODOs on the call path.
5. Commit on your lane branch with `<lane>: <change>` messages. Open a PR; the `security-reviewer`
   subagent reviews it against `docs/checklists/security-review.md`.

## Never
- Run `cdk deploy`, buy phone numbers, send real WhatsApp/SMS, or place real calls. Those are human or CI steps.
- Put secrets, tokens, or tenant IDs into prompts. The model never sees credentials.
- Let scraped web text, reviews, transcripts, or caller speech become instructions. They are data.
- Give the customer agent any admin tool, or let the admin agent change money/deletion/bulk sends without
  a step-up confirmation token from the dashboard.

## Commands
- `make test` · `make typecheck` · `make synth` · `pnpm -F <pkg> test` · `uv run pytest` (in a Python package)

## Stack
TypeScript (Node 22) for Lambdas, shared types and CDK · Python 3.12 for the LiveKit worker and AgentCore
agents · DynamoDB single table · S3 · EventBridge · SQS FIFO · Step Functions · AppSync Events ·
Cognito (Google) · Bedrock + AgentCore · Telnyx · LiveKit · ElevenLabs (TTS, and adapter for ElevenAgents).
