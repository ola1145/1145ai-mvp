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
- [ ] No dependency on a third-party approval (WhatsApp/Meta, SMS/10DLC, Calendar sensitive scopes, SES production access, app stores). See ADR-0005.
- [ ] No new package dependencies outside the P3 dependency batch (lockfile is owned by P3).
- [ ] Agent-facing text passes `@1145/conversation-style` checks (no robotic phrasing).

Added by the Q2 threat model (`docs/security/threat-model.md`; SEC-nn = findings register row):
- [ ] Text wrapped as data can't close its own wrapper (escape `<`/`>` or use a per-call boundary). (SEC-04)
- [ ] Principal and role mapping fails closed: an unknown or missing role is rejected, never defaulted to `owner`. (SEC-09, SEC-10)
- [ ] Anything that changes what customers hear (facts, prompts, hours, prices) or spends money needs an explicit
      owner action handled in code. A model's tool call alone is not approval. (SEC-05, SEC-20, SEC-21)
- [ ] LiveKit `sip.*` attributes are trusted only from SIP participants; web chat tokens can't set their own
      metadata or attributes. (SEC-06)
- [ ] New EventBridge rules match on `source`, and consumers check that any S3 key in an event starts with
      `tenants/<envelope tenantId>/`. (SEC-13, SEC-14)
- [ ] Server-side fetches of owner or third-party URLs block loopback, private, link-local and metadata addresses,
      including after redirects. (SEC-17)
- [ ] Outbound calls and transfers go only to allowed destinations (no premium-rate or international) and are
      rate-limited per tenant. (SEC-19)
- [ ] Minted tokens use the shortest TTL that fits the interaction. Tool responses don't carry secrets or owner
      phone numbers the model doesn't need. (SEC-08, SEC-23)
- [ ] Workflow changes don't interpolate PR titles, bodies, comments or logs into prompts or `run:` scripts, pin
      third-party actions, and don't widen who can trigger write-scoped jobs. (SEC-02, SEC-03)
