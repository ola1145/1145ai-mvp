# Target MVP architecture (B+)

Same three flows as v1. The edits from `01-architecture-review.md` are applied.

## Component map

```
 OWNER SIDE                                               CUSTOMER SIDE
 friend link 1145.ai/r/CODE ─► wa.me / t.me?start=CODE     PSTN caller            Web chat widget
          │                                                    │ dials tenant DID        │ LiveKit room, text mode
          ▼                                                    ▼                         │
 1145 WhatsApp number · 1145 Telegram bot · Web chat     Telnyx DID (per tenant)          │
          │ (Meta Cloud API / Bot API webhooks)                │ SIP (FQDN connection)    │
          ▼                                                    ▼                         ▼
 HTTP API  ── verify signature, 200 fast            LiveKit SIP ─ dispatch rule ─► room per call/chat
          ▼                                                    │
 SQS FIFO (group = sender, dedup = message id)       Agent worker "frontdesk" (ECS Fargate, Python)
          ▼                                            - tenant from sip.trunkPhoneNumber → resolver
 Router worker ── identity lookup                     - Deepgram Nova-3 · Bedrock LLM · ElevenLabs Flash TTS
    │ not yet a tenant        │ bound owner           - tools over HTTPS with a tenant-scoped token
    ▼                         ▼                                    │
 Onboarding agent        Admin agent                               │
 (AgentCore)             (AgentCore, owner only)                   │
    │ start/status             │ tenant token                      │
    ▼                          └─────────────► TENANT TOOL API ◄───┘
 Step Functions provisioning                    HTTP API + Lambda, ABAC role per tenant
  ├ number: search → order → bind (VoiceEngine)         │
  ├ knowledge: scrape → sanitize → owner confirms        ▼
  ├ profile: hours, services, rules (from chat)   DynamoDB (single table) · S3 (KB, transcripts) · S3 Vectors
  ├ name agent (waitForTaskToken)                       │
  └ smoke-test call to owner                            ▼
                                               EventBridge bus "1145"
                       ┌───────────────┬───────────────┼────────────────┬──────────────┐
                 post-call worker   usage meter   live publisher   audit writer   control plane
                 summary, sentiment  Stripe usage  AppSync Events   S3 Object Lock  suspend/resume
                 CRM upsert          caps                │
                                                         ▼
                                     Tenant app (Flutter) · Admin console (React) — built separately
```

## Trust boundaries

| Caller | How tenant is known | Token it holds | Tools it can reach |
|---|---|---|---|
| Customer agent (voice/web chat) | Dialed DID or widget key → resolver | `principal=customer-agent`, 15-min TTL, call-scoped | availability, book, reschedule*, cancel*, message, kb.search, caller.lookup, handoff |
| Admin agent | Bound channel identity → router | `principal=admin-agent`, session-scoped | reports, bookings, hours, services (prices need step-up), conversations |
| Owner dashboard | Cognito; `custom:tenant_id` set by pre-token trigger, not editable | Cognito ID token | everything the admin agent has, plus step-up issuance |
| ElevenAgents (fallback engine) | `system__agent_id` dynamic variable → `ENGINEAGENT#` route | per-workspace secret header | same as customer agent |
| Ops / control plane | IAM role per job, reason code required | IAM | read-heavy across tenants; writes audited |

\* reschedule and cancel require the verification step (Add-4).

## Two flows end to end

**Customer call.** Caller dials the DID → Telnyx sends SIP to LiveKit → dispatch rule creates a room and dispatches
`frontdesk` → the worker reads `sip.trunkPhoneNumber`, calls `/internal/resolve/number` with service credentials,
receives tenant config and a tenant token → speaks the disclosure line → STT/LLM/TTS loop, tools over HTTPS →
emits `call.started`, `booking.*` live → on hangup emits `call.ended` with transcript key → post-call worker
summarizes, scores sentiment, upserts the customer, records usage → AppSync Events updates the dashboard.

**Owner onboarding.** Friend shares `1145.ai/r/CODE` → click recorded → `wa.me` opens with the code → owner
messages → webhook → FIFO → router finds no identity → onboarding agent → collects name/type/area → sends signup
link (single-use, 15-min token bound to the WhatsApp identity) → Google sign-in → chat asks for reverse confirmation
→ identity bound → agent calls `start_provisioning` → state machine runs number/knowledge/profile branches in
parallel while the agent keeps asking about hours and services → owner confirms scraped facts → owner names the
agent → smoke-test call to the owner's phone → tenant `ACTIVE` → the router now sends this owner to the admin agent.

## MVP scope

**In:** owner onboarding on the shared WhatsApp number, shared Telegram bot and web chat · Google sign-in · new US
local number per tenant + conditional-forwarding instructions · customer voice and web chat · booking engine
(internal store) · knowledge answers from owner-confirmed facts only · take a message · handoff (transfer to owner's
phone or message) · admin agent (reports, bookings, hours/services edits with confirmation) · post-call summary,
sentiment, CRM upsert · usage metering and caps · Stripe subscription · control plane (tenant list, suspend/resume,
kill switch, audit log) · live events over AppSync Events · eval harness.

**Async unlocks (start the paperwork now, switch on per tenant when approved):** customer SMS (10DLC), customer
WhatsApp (tenant WABA via BSP), Google Calendar sync (sensitive-scope verification).

**Out (Phase 2+):** campaigns, number porting, customer Telegram, Outlook, ops agents, Twilio failover, owner barge-in
UI (backend supports it on LiveKit; UI later), video avatars, Stardog knowledge-graph layer, healthcare tenants.

## Non-functional targets

| Target | MVP value |
|---|---|
| Voice turn latency (end of caller speech → first audio) | p50 ≤ 900 ms, p95 ≤ 1.5 s |
| Tool call on the voice path | p95 ≤ 300 ms (provisioned concurrency) |
| Time from signup to working number | ≤ 5 minutes (excluding owner answer time) |
| Webhook acknowledgement | ≤ 1 s, always 200 after signature check |
| Concurrent calls | 20 at launch, load-tested to 50 |
| Data | us-east-1; transcripts retained 90 days by default; per-tenant export and delete |
