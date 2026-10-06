# Tool API performance and DynamoDB checks (T7)

Target: voice-path tools at **p95 <= 300 ms in dev**, measured through API Gateway with the real ABAC role
(AssumeRole + `tenant_id` session tag) and real DynamoDB. Nothing here has been measured yet: no numbers are
recorded until the owner runs the steps below in dev. Do not paste estimates into the table.

## What is already in place

- `ddb-repo.ts`: tenant credentials are cached per warm container for about 14 minutes (STS minimum session is 900 s,
  refreshed 60 s early). Concurrent first calls for one tenant share a single AssumeRole, failures are not cached,
  a client is never shared between tenants, and the cache is bounded to 200 tenants per container.
- `api-stack.ts`: voice routes run at 1024 MB (Lambda CPU scales with memory; starting point, untuned) and get
  provisioned concurrency (2) in prod. In dev, add `-c voiceProvisioned=true` to compare provisioned against on-demand.
- Voice handlers do at most one `Get`, one `Query` and (for booking) one `TransactWrite` per call.

## 1. Integration tests against DynamoDB Local

These cover the book transaction, slot conflict, idempotent replay, a concurrent race, tenant partition separation, GSI
lookups and the profile reads. DynamoDB Local does not enforce IAM, so ABAC is checked in dev (section 3).

```bash
# one of:
docker run --rm -p 8000:8000 amazon/dynamodb-local
# or: java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000

DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000 \
  pnpm vitest run --config services/tool-api/test-integration/vitest.config.ts
```

Without `DYNAMODB_LOCAL_ENDPOINT` the DynamoDB Local file is reported as skipped (not passed); the stubbed unit tests
in the same folder still run. The root vitest config only globs `services/*/test`, so `make test` does not run this
folder (see `contracts/CHANGE_REQUESTS/T7-1.md`).

## 2. Latency benchmark (dev only)

The owner mints a 15-minute customer-agent token for a seeded dev tenant (hours, a default service, a few facts):

```bash
TOOL_API_TOKEN_SECRET=<tokenCurrent from the dev tool-api secret> TENANT_ID=<seeded dev tenant> \
  pnpm tsx services/tool-api/bench/mint-token.ts

BASE_URL=<ToolApiUrl stack output> TOOL_TOKEN=<token from above> N=200 CONCURRENCY=4 \
  pnpm tsx services/tool-api/bench/run.ts
```

Run three times and record each: (a) after 30 minutes idle (cold), (b) warm, (c) deployed with
`-c voiceProvisioned=true`. `run.ts` reports the first request separately from p50/p95/p99 of the rest. The numbers are
client-observed, so run from a host in the same region as the dev API (a CI runner or CloudShell), not a laptop.

If p95 is over 300 ms, tune in this order and re-measure after each change: provisioned concurrency, memory
(`VOICE_MEMORY_MB` in `api-stack.ts`, try 1024 -> 1769), then the number of DynamoDB round trips per handler.

### Results

| Date | Build | Mode | Route | n | first | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| not yet measured | | | | | | | | |

## 3. Cross-tenant denial (dev, owner)

Confirms that IAM, not application code, stops a cross-tenant read. Needs AWS access to dev, so the owner runs it:

```bash
# Assume the tenant data role as tenant A (same call ddb-repo.ts makes).
aws sts assume-role --role-arn <TenantDataRole arn> --role-session-name t7-check \
  --tags Key=tenant_id,Value=<tenant A id> --duration-seconds 900
# export the returned AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, then:
aws dynamodb get-item --table-name <dev table> --key '{"PK":{"S":"TENANT#<tenant A id>"},"SK":{"S":"HOURS"}}'   # allowed
aws dynamodb get-item --table-name <dev table> --key '{"PK":{"S":"TENANT#<tenant B id>"},"SK":{"S":"HOURS"}}'   # AccessDeniedException
aws dynamodb get-item --table-name <dev table> --key '{"PK":{"S":"NUMBER#+12145550100"},"SK":{"S":"ROUTE"}}'    # AccessDeniedException
```

Record the date and the result here. Also confirm the Lambda role itself cannot read `TENANT#...` items directly
(only route items via `grantRouteRead`).

| Date | Allowed own tenant | Denied other tenant | Denied route items | Checked by |
|---|---|---|---|---|
| not yet checked | | | | |
