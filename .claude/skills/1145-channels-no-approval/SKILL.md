---
name: 1145-channels-no-approval
description: The 1145ai MVP channel map with zero third-party approvals — owner web chat (Cognito Google, basic scopes), shared Telegram bot, customer phone and web chat widget, referral links, owner notifications by Telegram/email/web push/call — and what is deferred (WhatsApp, SMS/10DLC, Calendar, app stores). Use whenever you touch channels, notifications, onboarding entry, referral flow, sign-in, or are tempted to add a messaging integration.
---

# Channels without approvals (ADR-0005)

| Who | MVP channel | Notes |
|---|---|---|
| Owner | Web chat after Google sign-in | Scopes `openid email profile` only (no Google review). Primary channel. |
| Owner | Shared Telegram bot `@1145_bot` | BotFather is instant. `/start CODE` carries referral. |
| Customer | Tenant phone number | Telnyx, bought by API. |
| Customer | Web chat widget | Widget key → LiveKit text room; same receptionist brain as calls. |
| Owner notifications | Telegram, email (Resend), web push (VAPID), phone call for urgent handoff | No SMS. |
| Viral entry | `1145.ai/r/CODE` → web onboarding | The friend shares it however they like (their own text is not A2P). |

Deferred to Phase 2 and must not appear in MVP code paths: WhatsApp (code exists, disabled), SMS, Google/Outlook
Calendar sync, SES production email, App Store/Play distribution. The owner app ships as Flutter web (PWA).
