# W1-11 · Tenant tool API and booking engine
**Agent:** tool-api-builder · **Branch:** lane/tool-api · **Depends on:** W0-01

## Owns
`services/tool-api/**`

## Already done (keep green)
create-booking, check-availability, lookup-caller, take-message, request-handoff, search-knowledge, tenant auth,
slot locks, DynamoDB repo with ABAC credentials. 20 tests.

## Tests first (write, watch fail, implement)
1. reschedule: requires verification for `customer-agent`; moves locks atomically (delete old + put new in one transaction).
2. cancel: releases locks; idempotent; emits `booking.cancelled`.
3. proposeChange: returns a 4-digit code unique among the tenant's open changes; 30-min TTL; price change sets `requiresStepUp`.
4. applyChange: only `owner`; unknown/expired code → 404; price change without valid step-up → 428; emits `admin.change_applied` and writes an audit record.
5. admin-summary / list-bookings / list-conversations: correct ranges in tenant timezone.
6. internal-resolve-number: wire ResolverDeps; suspended tenant returns `state: suspended`; unknown number 404.
7. Isolation test: a token for tenant A against a repo factory for tenant B never reads B (spy on repoFor).

## Verification design for reschedule/cancel (Add-4)
Default: the agent asks for the name on the booking AND the booked day; if both match a booking for the caller-ID
customer, the tool API issues a short-lived `verificationCode` bound to (callId, bookingId). Document alternatives in Status.

## Acceptance
- `pnpm -F @1145/tool-api test` green; p95 of create-booking ≤ 300 ms against DynamoDB Local in a benchmark script.

## Status
- state: IN PROGRESS (scaffold)
