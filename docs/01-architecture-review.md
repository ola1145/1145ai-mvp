# Architecture review: "Three flows, two engines" (v1)

**Reviewed:** 1145ai-architecture-userflow-two-options.pdf · **Date:** 2026-10-02 · **Status:** Proposed edits, awaiting owner approval (Gate 0)

## Verdict

The decomposition is right and most of it ships as drawn: three separated flows, the tenant-ID rule, a shared
core behind a thin voice-engine interface, Step Functions + EventBridge instead of Temporal, scraped text treated
as data, and step-up confirmation for risky admin actions.

Three things do not survive contact with your stated requirements or with US carrier and Meta rules:

1. **The default engine.** Option A (ElevenAgents) cannot give you the live-room dashboard you specified
   (streaming transcript, owner joins or takes over the call), and its biggest saving, native WhatsApp, disappears
   once you route WhatsApp through Telnyx/Twilio as you prefer. The grant is most likely denominated in characters,
   which Option B can spend directly through ElevenLabs TTS. So the default flips to **B+: LiveKit on Telnyx with
   ElevenLabs voices**, with Option A kept as an adapter and a fallback.
2. **SMS and per-tenant WhatsApp cannot be zero-touch.** Both need third-party approval per tenant (10DLC brand and
   campaign; a WhatsApp Business Account). They become *async unlocks*: the tenant goes live on voice and web chat in
   minutes, and these channels switch on when approval lands.
3. **Several runtime mechanics are missing** that decide whether the first real week works: webhook buffering and
   dedupe, double-booking prevention, caller-ID spoofing, live-event transport, tool latency on the call path, usage
   metering, and agent-template versioning.

Everything below is graded: **Keep**, **Change**, or **Add**. Each Add item is already scaffolded in the repo where noted.

---

## Keep (works as drawn)

| Element | Why it holds |
|---|---|
| Three flows with separate users, channels and failure costs | Lets Flow 1 and 2 ship before Flow 3; blast radius stays local |
| `tenant_id` from auth or dialed number, never model output | This is the single most important rule in the system. It is now enforced in IAM, not only in code (see Add-1) |
| Two agents per tenant, customer agent has no admin tools | Correct trust split. Keep the tool sets disjoint in code, not just in prompts |
| Owner messages first on WhatsApp (opens the service window) | No template needed to reply during onboarding |
| Telegram `t.me/BOT?start=CODE` with up to 64-char payload | Reliable referral attribution; the payload cannot be edited by the user |
| Step Functions + EventBridge, no Temporal for v1 | Right call. Use Standard workflows with `waitForTaskToken` for owner confirmations |
| Scraped site/social text stored as data, owner confirms facts before the agent quotes them | Keep, and add an instruction-pattern detector that flags passages for review |
| Step-up confirmation in the dashboard for money, deletion, bulk sends | Keep. Chat alone is not proof of intent |
| Immutable audit log on S3 Object Lock | Keep. Every ops write and every admin-agent change lands there |
| Thin voice-engine interface | Keep, but widen it (Change-9) so suspend, knowledge sync and smoke calls also go through it |
| Smoke-test call to the owner's phone as the demo close | Keep. It doubles as the go-live test |

---

## Change (will not work as drawn)

### Change-1 · Option A conflicts with requirements you already stated
**Problem.** You have asked for live-room calls with agent→owner transfer, a live streaming transcript, and SIP as a
must, on LiveKit + Telnyx with Deepgram Nova-3. In Option A the call lives inside ElevenLabs: the dashboard can show
call start (initiation webhook), tool calls as they happen (they hit your API), and the transcript after hangup
(post-call webhook). A mid-call transcript stream and an owner "join the room" are not part of that model; transfer is
a phone transfer to a number. *(Verify against current ElevenAgents docs before final sign-off.)*
**Fix.** Default to B+ (Change-3). Keep an ElevenAgents adapter behind the same interface so you can A/B voices,
fall back if the Telnyx path fails, or serve a tenant that prefers it.

### Change-2 · Option A's text-channel advantage depends on importing numbers into ElevenLabs
**Problem.** The PDF itself notes ElevenLabs cannot import a WhatsApp number managed by another provider. You prefer
Telnyx/Twilio as your WhatsApp partner. Those two choices are incompatible, so in practice you build your own text
runtime in both options. The "least code" argument for A shrinks to the voice loop only.
**Fix.** One text runtime that you own (channels gateway → router → agents). Customer web chat rides the same
LiveKit agent in text mode (one brain for voice and chat); WhatsApp/Telegram go through the gateway.

### Change-3 · Spend the ElevenLabs grant where it is certain to apply: TTS characters
**Problem.** The open gate is whether the grant covers *agent minutes* and paid multi-tenant use. Grants of this kind
are typically denominated in characters. The plan waits weeks on an answer that may be no.
**Fix.** B+ pipeline per call: Telnyx DID → LiveKit SIP → agent worker (ECS Fargate) with Deepgram Nova-3 STT,
Bedrock LLM, **ElevenLabs Flash TTS via the LiveKit plugin**. You get ElevenLabs voice quality, the room model,
one agent brain, and the grant applies to what it surely covers. Still send the grant question; ask specifically
whether commercial multi-tenant TTS use is allowed.

### Change-4 · Option B's "unproven per-tenant SIP headers" is mostly solved by the dialed number
**Problem.** The PDF lists per-tenant SIP headers on a shared trunk as unproven.
**Fix.** Do not route on custom headers. Use one inbound trunk and one dispatch rule; the agent reads the LiveKit SIP
participant attribute `sip.trunkPhoneNumber` (the dialed DID), resolves the tenant server-side, and gets a
short-lived tenant-scoped token. The Week-0 spike proves this with one call. Fallback if Telnyx-hosted LiveKit
misbehaves: LiveKit Cloud + a Telnyx SIP trunk, which is the well-documented path; the agent code does not change.

### Change-5 · SMS cannot be in the zero-touch path
**Problem.** US A2P SMS on local numbers requires a 10DLC brand and campaign per tenant (you register them as an ISV).
Approval takes days to weeks, and carriers block unregistered traffic. Toll-free needs verification too. AWS End User
Messaging has the same requirement. The PDF lists SMS as a day-one customer channel.
**Fix.** SMS becomes an async unlock: start your ISV registration in Week 0, register each tenant's brand during
onboarding, switch SMS on per tenant when the campaign is approved. Booking confirmations in the meantime: spoken
confirmation, plus email when the caller gives one.

### Change-6 · Per-tenant WhatsApp and Telegram are not configuration
**Problem.** A tenant-owned WhatsApp number needs its own WABA, Meta business verification and display-name approval,
whether you go direct or through Telnyx/Twilio (confirm with your BSP whether you also need Tech Provider
registration). Telegram has no Bot API call to create bots, so "a bot per tenant" means the owner creates it in
BotFather and pastes a token.
**Fix.** MVP: owners use the shared 1145 WhatsApp number and the shared 1145 Telegram bot (onboarding and admin
agent). Customer WhatsApp is an async unlock in Phase 2. Customer Telegram is deferred (low US usage).

### Change-7 · The onboarding agent should not orchestrate provisioning
**Problem.** The diagram has the agent "calling tools in parallel" to search and order numbers, scrape, and connect
the calendar. LLM-driven orchestration of side effects retries badly and double-buys numbers.
**Fix.** The agent calls exactly one tool to start provisioning and one to read status. The state machine runs the
parallel branches deterministically with idempotency keys. Owner confirmations ("is this right?", "name your agent")
are `waitForTaskToken` steps that the agent completes when the owner answers. *The agent asks; the workflow does.*

### Change-8 · Live dashboard transport
**Problem.** API Gateway WebSocket means you own connection tables, fan-out Lambdas and auth on `$connect`.
**Fix.** AppSync Events: managed pub/sub channels, Cognito auth, one namespace per tenant
(`/tenants/{tenantId}/live`). EventBridge → publisher Lambda → AppSync Events. Works for the Flutter tenant app and
the React admin console alike. (You already use AppSync on EHTravel.)

### Change-9 · Widen the voice-engine interface
**Problem.** "Create agent, bind number, receive events" misses operations both engines must support for billing and
fleet safety.
**Fix.** The interface (`packages/shared/src/voice-engine.ts`) adds `updateTenantAgent`, `syncKnowledge`,
`setTenantState` (suspend on failed payment), `placeSmokeTestCall`, and `normalizeCallEvent` (verifies the vendor
signature and returns one event shape).

### Change-10 · "Emails" on the dashboard implies restricted Gmail scopes
**Problem.** Showing an owner's emails needs Gmail read scopes, which Google classifies as restricted and which require a
third-party security assessment (CASA). That is weeks and money before launch.
**Fix.** No Gmail scopes in MVP. Google sign-in only; Calendar scope requested later in context (it is a sensitive
scope and still needs verification; start that early). Email as a channel later via a forwarding address
(`<tenant>@in.1145.ai` on SES inbound).

### Change-11 · Campaigns are a legal feature, not an admin-agent tool
**Problem.** The FCC treats AI-generated voices as "artificial voice" under the TCPA, so outbound AI marketing calls
need prior express written consent. WhatsApp marketing templates need opt-in and a tenant-owned WABA.
**Fix.** No campaigns in MVP. The admin agent gets reports, bookings, hours/services edits and conversation review.
Campaigns return in Phase 2 with a consent ledger per customer.

### Change-12 · Move CRM sync into Flow 2; cut Flow 3 to deterministic handlers
**Problem.** The PDF puts CRM sync in the control plane (page 5) and in the tenant runtime (page 4). Flow 3 also has
five agents for jobs that Stripe Smart Retries and a few rules already do.
**Fix.** CRM write is part of the post-call pipeline (Flow 2). Flow 3 MVP = admin console API (tenant list, usage,
suspend/resume, kill switch), Stripe webhook → `setTenantState`, audit log. Ops agents are Phase 3.

### Change-13 · Defer Twilio failover
A second carrier integration with no customers yet. Keep the carrier calls behind one module so it is possible
later. For MVP, the outage plan is an owner notice template and a status page.

### Change-14 · The Option B unit cost is optimistic for active tenants
**Problem.** "About $20 per tenant per month" holds for a quiet tenant. An active salon at ~300 calls × 3 min ≈ 900
minutes a month pays per-minute STT, LLM, TTS, carrier and agent compute.
**Fix.** Model COGS per minute, not per tenant, and meter usage from day one (Add-7), because pricing is
"tier + usage." Rough ranges to verify in the spike: Option A ≈ $0.10/min all-in (PDF's $0.08 + LLM + carrier);
B+ is lower, and much lower while TTS draws on the grant.

---

## Add (missing mechanisms)

| # | Mechanism | Why it matters | Where it lives |
|---|---|---|---|
| Add-1 | **Tenant isolation in IAM (ABAC)** — tool Lambdas assume a role with session tag `tenant_id`; DynamoDB `dynamodb:LeadingKeys` must equal `TENANT#${tenant_id}` | A code bug cannot read another tenant's partition | `infra/cdk/lib/data-stack.ts`, `services/tool-api/src/lib/tenant-auth.ts` |
| Add-2 | **Webhook buffering** — verify signature, enqueue to SQS FIFO (group = sender, dedup = message id), return 200 | Meta and Telegram retry slow webhooks; synchronous agent calls time out and duplicate replies | `services/channels` |
| Add-3 | **Double-booking prevention** — slot locks via DynamoDB transactional conditional writes; internal booking store is the source of truth, Google Calendar is a sync target | Voice and chat can book the same slot at the same second | `services/tool-api/src/lib/slots.ts` |
| Add-4 | **Caller ID is not identity** — lookup by caller number returns first name and "has upcoming booking" only; changes/cancellations require a verification step | Caller ID is trivially spoofed | `caller-lookup` handler, customer prompt |
| Add-5 | **Reverse identity confirmation** — after Google sign-in, the chat asks "Link j\*\*\*@gmail.com? Reply YES" | A forwarded signup link could otherwise bind a stranger's Gmail to the owner's WhatsApp | `services/provisioning/src/lib/signup-token.ts` |
| Add-6 | **Referral redirect link** — `1145.ai/r/CODE` records the click, then redirects to `wa.me` | Prefilled WhatsApp text can be edited away, losing attribution | channels + landing page |
| Add-7 | **Usage metering** — per-call billable seconds, per-tenant caps, Stripe usage records | Pricing is tier + usage; caps also stop cost abuse | `services/post-call/src/usage.ts` |
| Add-8 | **Agent template versioning** — tenant agents pin a template version; new versions roll out to a canary set first | One bad prompt change otherwise hits every tenant at once | `contracts/dynamodb/keys.md`, control plane |
| Add-9 | **Tool latency budget** — p95 ≤ 300 ms for voice tools; provisioned concurrency on the tool Lambdas; agent speaks a filler line on slow tools | Lambda cold starts become dead air on a phone call | tool-api + infra |
| Add-10 | **Overflow behavior** — what the caller hears when engine capacity is exhausted or the tenant is suspended (take a message) | 30 shared concurrent calls on ElevenAgents Scale; Telnyx-hosted capacity unpublished | voice engines |
| Add-11 | **Correlation IDs and tracing** — carrier call ID ↔ room/conversation ID ↔ tenant ↔ booking in every log line and event | You cannot debug a bad call without it | `packages/shared/src/events.ts` |
| Add-12 | **Conditional call forwarding as the default number path** — "ring me first, the AI answers if I don't" with carrier-specific codes and a test call | Most owners keep their number; porting comes later | onboarding flow |
| Add-13 | **ICP guardrail** — exclude healthcare tenants in MVP | PHI in transcripts means HIPAA and a BAA with every vendor on the call path | onboarding qualification |
| Add-14 | **Eval harness** — scripted scenarios (book, reschedule, after-hours, injection attempts, spoofed caller) run against every template version | A bad first call kills trust; this is the regression suite for prompts | `evals/` |
| Add-15 | **Confirmation codes, not LLM judgment** — the admin agent can only `proposeChange`; the owner replies `CONFIRM 1234` from the bound channel and the router applies it with an owner token | "Confirm before any change" is otherwise a prompt instruction the model can skip | `services/channels/src/router.ts`, `contracts/openapi/tenant-tools.yaml` |

## Internal inconsistencies in the PDF to resolve
- Page 6 lists native WhatsApp as an Option A strength; page 9 calls per-tenant WhatsApp "the long pole." Both are
  true only if the number lives in ElevenLabs.
- CRM sync appears in Flow 2 (page 4) and Flow 3 (page 5). Resolved: Flow 2.
- SMS appears as a day-one customer channel (page 4) and as "only for tenants that want it" (page 9). Resolved: async unlock.
- WhatsApp pricing: the PDF says Meta now bills service messages per message, citing a third-party source. Confirm on
  Meta's rate card before budgeting; reply-only onboarding traffic was free under the mid-2025 pricing model.

## Decisions requested (Gate 0)
1. Accept B+ (LiveKit on Telnyx + ElevenLabs TTS) as the MVP default, with the ElevenAgents adapter as fallback.
2. Accept SMS and customer WhatsApp as async unlocks, not day-one channels.
3. Default number path: new local number + conditional forwarding from the owner's existing number.
4. Google sign-in only at signup; Calendar scope requested later.
5. Exclude healthcare tenants from the MVP.
