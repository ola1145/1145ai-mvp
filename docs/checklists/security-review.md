# Security review checklist (used by the security-reviewer subagent on every PR)

- [ ] No `tenantId`/`tenant_id` read from an LLM tool argument, prompt, or model-filled body field.
- [ ] Every handler calls `requireTenantContext()` (TS) or `require_tenant()` (Py) before touching data.
- [ ] Customer-agent tool set and admin-agent tool set are disjoint; no admin route accepts `principal=customer-agent`.
- [ ] Price changes, deletions and bulk sends require a valid step-up token.
- [ ] Webhooks verify signatures with constant-time comparison before parsing.
- [ ] Webhook handlers return within 1 s and enqueue; no agent call inline.
- [ ] Idempotency key on every side-effecting operation (booking, number order, Stripe, outbound message).
- [ ] Scraped/third-party text is wrapped as data with provenance; instruction-like passages are flagged.
- [ ] Caller-ID lookup returns minimal data; changes require verification.
- [ ] No secrets, tokens or tenant IDs in prompts, logs at INFO, or events.
- [ ] Errors on the voice path degrade to "take a message".
- [ ] New IAM permissions are tenant-scoped (LeadingKeys / prefix) or justified in the PR.
