# Realtime channels (AppSync Events)

API: `1145-live`. Auth: Cognito user pool (owners/staff, ops) and IAM (publisher Lambda only).

| Namespace / channel | Subscribers | Published events |
|---|---|---|
| `/tenants/<tid>/live` | Owner and staff of `<tid>` (subscribe authorizer checks `custom:tenant_id`) | `call.started`, `call.ended`, `booking.*`, `message.taken`, `handoff.requested`, `onboarding.status`, `transcript.partial` (LiveKit engine only) |
| `/ops/fleet` | 1145 ops group | `tenant.state_changed`, alarms summary |

Payload = the EventBridge envelope from `contracts/events/events.schema.json`, minus internal fields.
Phone numbers are masked (`+1••••••1234`) in every realtime payload.
