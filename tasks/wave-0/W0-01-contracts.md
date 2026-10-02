# W0-01 · Freeze contracts v0.1
**Agent:** contracts-architect · **Branch:** lane/contracts · **Blocks:** all of Wave 1

## Goal
Make `contracts/` and `packages/shared/` complete enough that seven lanes can build against them without talking to each other.

## Owns
`contracts/**`, `packages/shared/**`

## Tests first
- `packages/shared/test/*`: token tamper/expiry/rotation, tool permission matrix (customer vs admin-agent vs owner), key-segment injection, phone masking. (Exist; extend.)
- Add a test that every `operationId` in `contracts/openapi/tenant-tools.yaml` maps to a `ToolName` or an internal route.

## Steps
1. Review the OpenAPI and add request/response examples for every voice-path operation.
2. Add JSON Schemas for every event type in `contracts/events/events.schema.json` `$defs` (some are missing).
3. Add `contracts/openapi/dashboard.yaml` listing `/dash/*` routes (same handlers, Cognito auth).
4. Generate or hand-write matching TS types in `packages/shared/src`; keep zero runtime deps.
5. Process any `contracts/CHANGE_REQUESTS/*` that exist.

## Acceptance
- `make test` green; `python -c "import yaml; yaml.safe_load(open(...))"` passes for every YAML.
- No lane brief in `tasks/wave-1` references a field that is missing from contracts.

## Status
- state: TODO
