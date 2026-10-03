# Realtime channels (AppSync Events)

API: `1145-live`. Auth: Cognito user pool (owners/staff, ops) and IAM for publishers: the live-publisher Lambda
(`/tenants`, `/ops`) and the channels router (`/owners` only, CR C1-1).

| Namespace / channel | Subscribers | Published events |
|---|---|---|
| `/tenants/<tid>/live` | Owner and staff of `<tid>` (subscribe authorizer checks `custom:tenant_id`) | `call.started`, `call.ended`, `booking.*`, `message.taken`, `handoff.requested`, `onboarding.status`, `transcript.partial` (LiveKit engine only; arrives over the bus like every other event, CR E2-1) |
| `/owners/<sub>/chat` | The signed-in owner (subscribe handler checks the Cognito `sub`) | Agent replies for the owner web chat (onboarding and copilot), see below |
| `/ops/fleet` | 1145 ops group | `tenant.state_changed`, alarms summary |

Payload on `/tenants` and `/ops` = the EventBridge envelope from `contracts/events/events.schema.json`, minus internal fields.
Phone numbers are masked (`+1••••••1234`) in every realtime payload.

## Owner chat replies (`/owners/<sub>/chat`, CR C1-1)
Not an EventBridge envelope (there is no tenant yet during onboarding). Each reply is published as one event string
containing JSON:

```json
{ "type": "chat.reply", "version": 1, "occurredAt": "2026-10-03T15:00:00.000Z",
  "data": { "role": "agent", "text": "Nice, Kemi Cuts it is. What hours are you open?", "inReplyTo": "c_01J9ZS" } }
```

`data.inReplyTo` (the `clientMessageId` from `POST /v1/owner-chat/messages`) is optional. The web app renders `data.text`.
