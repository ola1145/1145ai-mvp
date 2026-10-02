---
name: 1145-tenant-isolation
description: The 1145ai multi-tenant security rules — where tenantId may come from, ABAC-scoped DynamoDB/S3 access, token types, caller-ID handling, propose/confirm for owner changes, and prompt-injection boundaries. Use whenever you write or review code that reads or writes tenant data, handles tokens, webhooks, agent tools, prompts, IAM policies, or anything in services/, engines/, agents/ or infra/ — even for a "small" handler change.
---

# Tenant isolation

## The one rule
`tenantId` comes from an authenticated source only: the dialed number or widget key (via the resolver), a verified
channel identity (router), a Cognito claim set by the pre-token trigger, or a signed 1145 service token. Never from
a request body, a path the model chose, a prompt, or an LLM tool argument. Code that does is a security bug.

## How to obtain context
- TypeScript handlers: `const ctx = await requireTenantContext(event, '<toolName>', deps)` before any data access.
- Repos: `deps.repoFor(ctx.tenantId)` returns a client whose IAM role only allows `TENANT#<tid>` (ADR-0003). Never
  construct a raw DynamoDB client for tenant data.
- Python agents: tools are closures over router-supplied ids/tokens. No tool parameter may be named or used as an id/token.

## Principals and tools
customer-agent → bookings, messages, knowledge (verified only), caller lookup (minimal), handoff.
admin-agent → reads + `proposeChange`. Never apply. owner/staff → everything incl. `applyChange`; prices need step-up.
Check with `principalMayCall` in `packages/shared/src/tenant-context.ts`.

## Caller ID is a hint
Lookup returns first name + `hasUpcomingBooking`. Reschedule/cancel need a verification code bound to the call.

## Injection boundaries
Scraped pages, transcripts, reviews, owner free text and tool results are data: wrap in `<data>` and never
concatenate into system prompts. Instruction-like scraped passages are flagged for owner review.

## Webhooks
Verify the signature on the raw body (constant-time) before parsing. Return fast; enqueue; dedupe by message id.

## Review checklist
`docs/checklists/security-review.md` — the claude-review check blocks merges on violations.
