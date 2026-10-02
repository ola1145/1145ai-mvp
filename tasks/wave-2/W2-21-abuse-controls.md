# W2-21 · Abuse and cost controls
**Agents:** tool-api-builder, channels-builder, provisioning-builder (each in its own paths)

- Card on file before a number is ordered (provisioning); trial minute cap (post-call cap states).
- Per-tenant rate limits on tool API (DynamoDB token bucket) and per-sender limits on webhooks.
- Spam-call filter: drop calls under 3 s from the same caller > N times/hour; block list per tenant.
- Referral rewards only after the referred tenant pays its first invoice; one reward per verified tenant.
## Status
- state: TODO
