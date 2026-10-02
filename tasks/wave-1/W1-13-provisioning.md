# W1-13 · Onboarding provisioning, signup and identity binding
**Agent:** provisioning-builder · **Branch:** lane/provisioning · **Depends on:** W0-01

## Owns
`services/provisioning/**` (the state machine shape lives in `infra/cdk/lib/provisioning-stack.ts`; request changes via CHANGE_REQUESTS)

## Already done
Sanitizer with instruction-pattern flags, signup token mint/consume, reverse-confirmation text, Telnyx client,
retry-safe orderNumber. 5 tests.

## Tests first
1. Onboarding internal API handlers (`contracts/openapi/onboarding-internal.yaml`): basics, waitlist, signup-link
   (sends the link through the channel sender; response body never contains the token), provisioning start
   (execution name = onboardingId; 409 until identity confirmed), hours/services parse (LLM output validated against
   BusinessHours schema; reject and re-ask on invalid), facts decisions (complete task token), agent name (complete task token).
2. Signup callback: consume token → PENDING binding → reverse confirmation message; "YES" in chat → binding ACTIVE.
   A second Google account using the same token gets "link already used".
3. Steps: search-number (area code → state fallback), bind-engine (writes NUMBER#/ENGINEAGENT# routes),
   scrape-knowledge (robots-aware, 10 pages, 5 s timeout, size cap), render-agent (pinned template version),
   smoke-call, activate-tenant (submits 10DLC brand as a separate async-unlock execution).
4. Card-on-file check before OrderNumber (abuse control); no card → status message "add a card to get your number".

## Acceptance
- A local state-machine run with fakes completes end to end; a forced retry of OrderNumber buys one number.

## Status
- state: IN PROGRESS (scaffold)
