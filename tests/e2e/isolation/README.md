# Tenant isolation, end to end ([1145:Q1])

Proves that tenant A can never read or change tenant B through any path. Zero dependencies beyond vitest: SigV4,
STS, DynamoDB and AppSync are called with `fetch` / the Node 22 global `WebSocket`.

| Suite | What it does | Passes only if |
|---|---|---|
| Tool API (`src/probes/tool-api.ts`) | Token A calls every route in `contracts/openapi/tenant-tools.yaml` with tenant B ids in path, query, body and headers; also forged tokens (missing, garbage, tid swapped with the signature kept, `alg=none`) | no B marker in any response, B-only objects answer 4xx, forged tokens get 401/403, and afterwards B's booking is unchanged and A's canary text is absent from B's view |
| Data plane (`src/probes/data-plane.ts`) | `sts:AssumeRole` on the tenant data role with tag `tenant_id=A`, then straight to DynamoDB: Query, GetItem, GSI1, Scan, BatchGet, PutItem on `TENANT#B`, plus `NUMBER#` / `IDENTITY#` route items; repeated B to A | every one is `AccessDeniedException` (any other error is a failure, not a pass) |
| Realtime (`src/probes/realtime.ts`) | Cognito JWT of A subscribes to `/tenants/<B>/live`, `/owners/<subB>/chat`, `/ops/fleet`, and publishes to B's channel | all denied |

Every suite starts with a control (own token works, own data is visible, own channel subscribes). If the control
fails the suite fails: a denial from a broken token or an empty table proves nothing.

## Run

```
pnpm vitest run --root tests/e2e/isolation          # self-tests always run; real suites skip with a message
ISOLATION_REQUIRE=1 ... (nightly / post-deploy)     # a skipped suite becomes a failure
```

`test/selftest.test.ts` runs the same probes against in-memory fakes and proves they pass on a correct system and
fail for each specific bug (trusting a body tenant id, global id lookup, unverified signature, prefix-only IAM,
open ops channel, ...). `test/routes-drift.test.ts` fails when a route appears in the OpenAPI contract without a probe.

## Environment (nothing is hard-coded)

Tenants A and B must be dedicated throwaway dev tenants: the run calls mutating routes (`updateHours`,
`proposeChange`, `takeMessage`, `createBooking`) as A, and attempts to cancel B's seeded booking.

| Variable | Suite | Meaning |
|---|---|---|
| `ISOLATION_A_TENANT_ID`, `ISOLATION_B_TENANT_ID` | all | `t_...` ids, must differ |
| `ISOLATION_API_URL` | tool | base URL of the dev tool API |
| `ISOLATION_A_TOKEN`, `ISOLATION_B_TOKEN` | tool | owner-principal tenant tokens (HS256, aud tool-api), minted out of band, so routes are tested for isolation and not refused for principal |
| `ISOLATION_B_BOOKING_ID`, `ISOLATION_B_SERVICE_ID` | tool | B's seeded confirmed booking and service |
| `ISOLATION_B_MARKERS` | tool | comma list, 5+ chars each, strings that exist only in B (customer first name on the seeded booking, a verified knowledge fact) |
| `ISOLATION_B_NUMBER` | tool, data | optional E.164 of B's number |
| `ISOLATION_ASSUME_ROLE_ARN` | data | tenant data role (`TenantDataRole`) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | data | caller allowed `sts:AssumeRole` + `sts:TagSession` on that role |
| `ISOLATION_TABLE` | data | optional, default `t1145` |
| `ISOLATION_B_IDENTITY` | data | optional `channel#id` for the identity route probe |
| `ISOLATION_APPSYNC_HTTP_HOST` | realtime | `<id>.appsync-api.<region>.amazonaws.com` |
| `ISOLATION_APPSYNC_REALTIME_HOST` | realtime | optional, derived from the HTTP host |
| `ISOLATION_A_COGNITO_JWT` | realtime | Cognito token of an owner of A |
| `ISOLATION_B_COGNITO_JWT`, `ISOLATION_B_OWNER_SUB` | realtime | optional: enables the B to A direction and the owner-chat probe |
| `ISOLATION_REQUIRE` | all | `1` makes any skipped suite fail |

Not yet exercised against real AWS (owner follow-up): the AppSync Events wire format in `src/adapters/appsync.ts`.
The STS/DynamoDB signer is checked against the AWS `get-vanilla` SigV4 test vector.
