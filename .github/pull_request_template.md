<!-- Title must start with [1145:<ID>] — the ownership check reads it. -->
Linear: <issue URL>

## What changed
-

## Tests first
- [ ] Tests from the brief were written before the implementation and pass
- [ ] `make test` passes locally

## Checklist
- [ ] Only files under my issue's **Owns** changed; no lockfile edits
- [ ] No tenant id from request bodies or tool arguments
- [ ] No WhatsApp / SMS / Calendar / SES-prod / app-store dependency (ADR-0005)
- [ ] Customer/owner-facing text sounds like a person (conversation-style passes)
