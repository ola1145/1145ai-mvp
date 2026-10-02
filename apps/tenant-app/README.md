# Owner app (Flutter web / PWA) — built by the owner (issue U1)

Ship as Flutter web (installable PWA) for the MVP; App Store / Play review is Phase 2 (ADR-0005).

- Sign-in: Cognito hosted UI with Google (`openid email profile`). ID token carries `custom:tenant_id` (read-only).
- Owner chat (onboarding before a tenant exists, copilot after): `POST {hooks}/v1/owner-chat/messages`
  `{ text, clientMessageId, referralCode? }`; replies arrive on AppSync Events `/owners/<sub>/chat`.
- Live view: subscribe to `/tenants/<tenantId>/live` (call.started, transcript.partial, booking.*, message.taken…).
- REST: `{api}/dash/v1/...` (same operations as `contracts/openapi/tenant-tools.yaml`, Cognito auth).
- Pending changes: the chat shows "Reply CONFIRM 1234"; the app can confirm via `/dash/v1/admin/changes/apply`.
  Price changes open a step-up screen first (`X-Step-Up-Token`).
- Card on file during onboarding: Stripe SetupIntent from `/internal/onboarding/{id}/payment-setup` via the chat flow.
- Web push: register a service worker with `VAPID_PUBLIC_KEY`; send the subscription to the notifications service.
- Customer web chat widget for tenants' websites: `POST {hooks}/v1/webchat/token { widgetKey }` → LiveKit room (text).
- Phone numbers arrive masked; never unmask client-side.
