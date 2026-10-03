# Control plane

Stripe webhook (H1), audit writer (H1), abuse controls (H3) and the admin console API (H2, this file).

## Admin console API (for the owner's React admin console)

Base URL: the `ConsoleApiUrl` output of stack `ai1145-<stage>-controlplane` (ends in `/console`).
Everything below is relative to it, so `GET /tenants` means `GET <ConsoleApiUrl>/tenants`.

### Who can call it

The `/console/*` routes use IAM authorization. Every request must be SigV4-signed (service `execute-api`,
region `us-east-1`) by a principal that has the managed policy named in the `ConsoleInvokePolicyArn` output.
Attach that policy to the role or group 1145 staff sign in with. The UI has to obtain temporary AWS credentials for that
role (for example through a Cognito identity pool or IAM Identity Center) and sign with them. There is no API key and no
Cognito JWT on these routes.

The caller's IAM ARN is the **actor** in every audit record. A body field called `actor` (or `tenantId`) is ignored.
The tenant is always the `{tid}` in the path. It must look like `t_[a-z0-9]{8,40}` or the call gets 400 `invalid_tenant_id`.

### Rules the API enforces

1. **Every write needs a reason code.** Send `reasonCode` in the JSON body, one of
   `billing`, `abuse`, `owner_request`, `support_case`, `security`, `compliance`, `incident`, `testing`.
   Missing or unknown gives 400 `reason_code_required` with the allowed list. An optional `note` (max 500 chars) is stored
   in the audit record as plain data.
2. **Every write is audited** to the Object Lock bucket. Destructive writes (pin, unpin, export, delete) record the audit
   entry first and do nothing if that fails (500). Suspend and resume go through `setTenantState` (engine first, then
   state, then the audit entry).
3. **Transcripts and exports are readable only with a support case id.** Send `?supportCaseId=SUP-1042`
   (letters, a dash, digits). Without one the API answers 403 `support_case_required` and records the refused attempt.
   Every successful read is audited with the case id and the actor. The id is checked for shape only; there is no
   support-desk lookup yet.
4. Responses are `application/json` with `cache-control: no-store`. Errors look like `{ "error": "<code>", ... }`.
   Phone numbers are always masked (`+4•••••••4567`). Channel tokens and other profile internals are never returned.

### Endpoints

| Method and path | Body or query | Result |
|---|---|---|
| `GET /tenants` | `?limit=25` (1 to 100), `?cursor=` | `{ items: TenantSummary[], nextCursor }`. Follow `nextCursor` until it is `null`; a page can be short. |
| `GET /tenants/{tid}` | none | `{ tenant: TenantSummary, usage: [{ month, billableSeconds }] }` (last 3 months) |
| `GET /tenants/{tid}/usage` | `?months=6` (1 to 24) | `{ tenantId, usage: [{ month: "2026-10", billableSeconds }] }` |
| `POST /tenants/{tid}/suspend` | `{ reasonCode, note? }` | `{ tenantId, state: "suspended", previous, changed }`. Already suspended gives `changed: false`, no write, no audit. |
| `POST /tenants/{tid}/resume` | `{ reasonCode, note? }` | `{ tenantId, state: "active", previous, changed }` |
| `GET /templates/{name}` | none | `{ template, versions: [{ version, status, canaryPercent? }] }` for the pin picker |
| `PUT /tenants/{tid}/template` | `{ template, version, reasonCode, note? }` | `{ tenantId, template, version, pinned: true }`. 404 `template_version_not_found`, 409 `template_version_retired`. |
| `POST /tenants/{tid}/template/unpin` | `{ reasonCode, note? }` | `{ tenantId, pinned: false }` |
| `GET /tenants/{tid}/conversations` | `?limit=25`, `?cursor=` | `{ items: [{ conversationId, startedAt, channel?, sentiment?, hasTranscript }], nextCursor }`. Metadata only. |
| `GET /tenants/{tid}/conversations/{startedAt}/{conversationId}/transcript` | `?supportCaseId=` (required). `startedAt` is the ISO time from the list, URL-encoded. | `{ tenantId, conversationId, supportCaseId, transcript }` |
| `POST /tenants/{tid}/export` | `{ reasonCode, note? }` | `{ tenantId, exportId, key, itemCount }`. Writes the tenant's records (not transcripts, not idempotency items) to `tenants/<tid>/exports/<exportId>.json`. |
| `GET /tenants/{tid}/exports/{exportId}` | `?supportCaseId=` (required) | `{ tenantId, exportId, supportCaseId, export }`. Returned inline, so it only suits exports under about 5 MB. |
| `POST /tenants/{tid}/delete` | `{ reasonCode, confirmTenantId, note? }` | `{ tenantId, deleted: { items, objects, routes }, numbersToRelease: [masked], auditFinalized }` |

`TenantSummary`: `tenantId, name, type, timezone, state ("active" | "suspended" | "over_cap"), stateReasonCode, stateUpdatedAt,
engine, templateVersion, templatePin { template, version, at }, numbers (masked), createdAt`.

Show the UI user a confirm step on suspend, resume and delete. Delete is only allowed when the tenant is already
suspended (409 `suspend_first` otherwise) and `confirmTenantId` must equal the path id (400 `confirm_tenant_id_mismatch`).
If a delete fails part way it returns 500 `delete_incomplete`; repeating the same request is safe because the profile is
removed last. Deleting does not release phone numbers with the carrier, so show `numbersToRelease` to the operator.

Error codes you will see: `unauthenticated` 401, `invalid_tenant_id` / `invalid_json` / `invalid_note` /
`invalid_version` / `invalid_template` / `invalid_cursor` / `invalid_conversation` / `invalid_export_id` 400,
`support_case_required` / `transcript_key_outside_tenant` 403, `*_not_found` / `no_transcript` / `not_found` 404,
`method_not_allowed` 405, `suspend_first` / `engine_not_provisioned` / `template_version_retired` 409,
`state_change_failed` 502 (the engine call, the write or the audit failed; repeating the request is safe),
`internal_error` 500.

CORS: set CDK context `consoleOrigins` (comma separated) when the UI is served from a browser origin, for example
`pnpm cdk synth -c consoleOrigins=https://admin.1145.ai`. With no value no CORS headers are sent.

### Not done yet (stubbed or waiting on another lane)

- Audit entries are written by a local writer (`src/console/audit-sink.ts`) until H1 exports one (`contracts/CHANGE_REQUESTS/H2-1.md`).
- Tenant list scans the table; a tenant index is requested in `H2-2.md`, which also lists the profile fields the console assumes.
- Suspend and resume work for the `livekit-telnyx` engine (they flip the tenant's `NUMBER#` routes). The `elevenlabs`
  engine returns 502 until its credentials are wired in.
- Pinning records `templatePin` on the profile; the render step has to honour it (`H2-3.md`).
- Support case ids are checked for shape only.

## Local checks

`pnpm vitest run services/control-plane/` and `make synth`. Nothing here deploys or calls AWS; CI deploys to dev after merge.
