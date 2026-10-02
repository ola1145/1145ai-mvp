---
name: 1145-provisioning-telnyx
description: Zero-touch tenant provisioning for 1145ai — onboarding internal API, Step Functions workflow with waitForTaskToken owner steps, card-on-file gate, Telnyx number search/order/assign with idempotency, engine binding, knowledge scraping, agent template rendering, smoke call and activation. Use for any work in services/provisioning, scripts/telnyx, or provisioning-stack.ts.
---

# Provisioning

The agent asks; the workflow does. The onboarding agent calls `start_provisioning` and `provisioning_status`;
the state machine (execution name = onboardingId) does everything with side effects.

Order: CheckPaymentMethod → Parallel[ number: search → order → bind · knowledge: scrape → AwaitFactsConfirmed ·
profile: AwaitProfileComplete ] → RenderAgent → AwaitAgentName → SmokeCall → ActivateTenant.

- Idempotency: every side effect keyed by onboardingId (e.g. `ORDER#<onboardingId>` conditional put before buying).
- Telnyx: v2 REST, Bearer key. Search is free; ordering costs money (tests use fixtures; dev uses a spend limit).
  US local numbers need no regulatory approval. Assign numbers to the LiveKit FQDN connection.
- Owner steps store the task token; the onboarding API completes it with SendTaskSuccess.
- Status messages to the owner are chat copy: follow `1145-conversation-style`.
- No third-party approvals anywhere in this flow (no 10DLC, no WABA). ADR-0005.
