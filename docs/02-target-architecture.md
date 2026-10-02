# Target MVP architecture (B+, no third-party approvals)

Three flows, unchanged in shape. Every channel below works with an account and an API key (ADR-0005).

```
OWNER SIDE                                              CUSTOMER SIDE
friend shares 1145.ai/r/CODE (by any means)             caller dials tenant DID          website visitor
        │                                                     │                              │ widget key
        ▼                                                     ▼                              ▼
referral redirect (click logged) ─► web chat (Google sign-in)  Telnyx DID ─SIP─► LiveKit ◄─ webchat token endpoint
            or t.me/1145_bot?start=CODE (Telegram)                              │ room per call / chat
        │                                                                       ▼
owner-chat API / Telegram webhook ─► SQS FIFO ─► router            frontdesk worker (ECS Fargate)
        │  identity route                                           tenant from dialed number or widget key
        ├─ not a tenant yet ─► onboarding agent (AgentCore)         Deepgram STT · Bedrock LLM · ElevenLabs TTS
        └─ bound owner ─────► admin agent (AgentCore)               natural turn-taking, fillers, interruptions
                 │ propose only;  owner "CONFIRM 1234" applies                  │ tenant token
                 ▼                                                              ▼
        onboarding API ─► Step Functions provisioning         TENANT TOOL API (ABAC per tenant)
          card on file → number (Telnyx) → bind engine          bookings · knowledge · messages · handoff
          scrape → owner confirms facts → render agent                         │
          → owner names agent → smoke call → active                            ▼
                                                           EventBridge ─► post-call · usage · live (AppSync Events)
                                                                      └► notifications: Telegram · email · web push · call
                                                           Flutter web/PWA (owner) · React admin console — built by owner
```

## Channels (MVP)

| Who | Channel | Approval needed |
|---|---|---|
| Customers | Phone (tenant DID), web chat widget | None |
| Owners | Web chat (Google sign-in, basic scopes), Telegram bot, dashboard | None |
| Notifications to owners | Telegram, email (Resend), web push, phone call (urgent) | None |
| Phase 2 | SMS, WhatsApp, Calendar sync, app stores | Yes, so deferred |

## Trust boundaries
Unchanged from v1: tenant from dialed number / widget key / verified identity / Cognito claim, never from model output.
Owner web chat is authenticated by Cognito from the first message, so the reverse-confirmation step applies only to
Telegram onboarding.

## Conversation quality is a requirement, not polish
Every agent (voice frontdesk, web chat, onboarding, admin) follows `.claude/skills/1145-conversation-style`.
CI enforces it with `@1145/conversation-style` on eval transcripts, and post-call analysis flags robotic turns.

## Non-functional targets
Voice turn latency p50 ≤ 900 ms, p95 ≤ 1.5 s · voice tools p95 ≤ 300 ms · signup to working number ≤ 5 min ·
webhooks ack ≤ 1 s · 50 concurrent calls load-tested · transcripts retained 90 days.
