# Tenant app (Flutter) — built separately

Mobile app and tenant dashboard for owners and staff. Not scaffolded here; it integrates against contracts.

- Auth: Cognito hosted UI with Google. The ID token carries `custom:tenant_id` (read-only to the user).
- REST: `https://api.<stage>.1145.ai/dash/v1/...` — same operations as `contracts/openapi/tenant-tools.yaml`.
- Live: AppSync Events, subscribe to `/tenants/<tenantId>/live` (events in `contracts/events/events.schema.json`).
- Pending changes: show the code from `admin.change_applied` / `proposeChange`; tapping Confirm calls
  `/dash/v1/admin/changes/apply`. Price changes open the step-up screen first (`X-Step-Up-Token`).
- Phone numbers arrive masked; never unmask client-side.
