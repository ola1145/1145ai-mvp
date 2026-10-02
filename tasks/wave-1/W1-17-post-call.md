# W1-17 · Post-call pipeline, usage metering, live publisher
**Agent:** postcall-builder · **Branch:** lane/post-call · **Depends on:** W0-01

## Owns
`services/post-call/**`

## Already done
Billable seconds, cap states, idempotent `onCallEnded`. 3 tests.

## Tests first
1. `analyze` prompt returns schema-valid JSON for messy transcripts; transcript text is quoted data (injection test).
2. `upsertCustomerFromCall` merges by phone (GSI1) without overwriting owner-edited fields.
3. `addUsage` is an atomic counter per month; `over` cap flips the number route state to `over_cap` (calls go to take-a-message) and notifies the owner.
4. Stripe usage record per call (idempotency key = callId).
5. Live publisher: masks phones; drops internal fields.

## Acceptance
- Replaying the same `call.ended` 3 times yields one usage record, one customer update, one live event.

## Status
- state: IN PROGRESS (scaffold)
