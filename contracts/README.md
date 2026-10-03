# contracts/ (owner: C0)

The source of truth every lane builds against. `packages/shared` mirrors it in TypeScript. CI keeps the two in step:
`pnpm vitest run packages/shared` runs `contracts.test.ts` and `events.test.ts`.

| Path | What |
|---|---|
| `openapi/tenant-tools.yaml` | Tool API used by agents and the dashboard, plus `/internal/resolve/number` |
| `openapi/channels.yaml` | Owner chat, customer web chat token, referral redirect, Telegram webhook, `/internal/resolve/widget` |
| `openapi/onboarding-internal.yaml` | Onboarding internal API (service token) and the signup callback |
| `events/events.schema.json` | EventBridge envelope and one `$defs` entry per event type |
| `dynamodb/keys.md` | Single-table key design and which role may touch which prefix |
| `realtime/channels.md` | AppSync Events namespaces and payloads |

## Rules
1. **Additive only.** Once merged, a field, operation, enum value or key is never renamed or removed in the MVP. Add a
   new optional field, mark the old one `deprecated: true`, remove it in Phase 2.
2. **Tenant identity never appears in a request body or a model-chosen path.** It comes from the credential.
3. Customer- and owner-facing strings in examples (`sayToCaller`, `spoken`, `greeting`, `disclosureLine`,
   `messageForOwner`) follow `1145-conversation-style`; the tests run the voice ones through `@1145/conversation-style`.

## OpenAPI conventions (checked by `packages/shared/test/contracts.test.ts`)
- `operationId`: unique across all files, lowerCamelCase. It is also the tool name in `principalMayCall`.
- `x-handler`: repo-relative path of the Lambda entry, e.g. `services/tool-api/src/handlers/check-availability.ts`.
  The file must exist, and a stack in `infra/cdk/lib` must route the same method + path to it.
- `x-principals`: who may call it. Must match `CUSTOMER_TOOLS` / `ADMIN_AGENT_TOOLS` / `OWNER_TOOLS` in
  `packages/shared/src/tenant-context.ts`.
- `x-voice-path: true`: called during a live call or chat (every customer-agent tool, both resolvers, every route with
  `voice: true` in `api-stack.ts`). These need `application/json` examples for the request body (if any) and every 2xx
  response; every example must validate against its schema. Share an example with `components/examples`.
- Cross-file refs are allowed (`tenant-tools.yaml#/components/schemas/ResolvedCall`).
- YAML stays within the subset `packages/shared/test/support/yaml-lite.ts` parses: no anchors, aliases or tags, and
  quote any flow scalar that contains `, : # { } [ ]`.

## Events (checked by `packages/shared/test/events.test.ts`)
`EVENT_TYPES` in `packages/shared/src/events.ts` must equal the envelope `type.enum`, and each type needs a `$defs`
entry with at least one `examples` item that validates.

## Change requests
Write `contracts/CHANGE_REQUESTS/<your ID>-<n>.md`: what, why, the exact proposed change (schema snippet), and who
else is affected. C0 accepts (one PR updating contracts + packages/shared) or rejects with a reason on the Linear issue,
within 4 hours. Parts that belong to another lane are forwarded to that lane's owner.

### Log
| CR | Decision | Landed in contracts/shared | Forwarded |
|---|---|---|---|
| C1-1 | Accepted | `keys.md`: `ONBOARDING#`, `MSGDEDUP#`, IDENTITY route fields, `referrerTid`. `realtime/channels.md`: `chat.reply` payload, router may publish to `/owners` | §3 Telegram sender export: C2 |
| C1-2 | Partly accepted | §3 `DataStack.grantRouteRead` now grants `kms:Decrypt` on the table key | §1 `bin/app.ts`: P2. §2 one signing secret: `api-stack.ts` owner (T7). §4 SSM ARNs: A1 |
| E2-1 | Accepted | `transcript.partial` in `EVENT_TYPES`, envelope enum and `$defs` | `ToLive` rule in `realtime-stack.ts`: P6. Transcript object shape: post-call (G-lane). S3 grants: voice-stack owner |
| E5-1 | Accepted | `/internal/resolve/widget` body `{ widgetKey, callId }`; room metadata and token rules in `createCustomerWebchatToken` | Implementation: C4 (token), T5 (resolver) |
| T0-1 | Partly accepted | `keys.md`: `PROFILE.handoffWindow` | `ddb-repo.ts`, `deps.ts`: T0/T7. New SDK deps: P3 |
| T2-1 | Partly accepted | `keys.md`: `CHANGECODE#`, `AUDIT#`. `admin.change_applied` `$defs`. `proposeChange` 201 `messageForOwner`; `applyChange` 200 `AppliedChange`; step-up token format on `X-Step-Up-Token` | `repo.ts`, `ddb-repo.ts`, `fakes.ts`, `deps.ts`: T0/T7 |
| A3-1, A3-2, E5-2 | Not contract changes | none | A1, A4, P3, E4 |
