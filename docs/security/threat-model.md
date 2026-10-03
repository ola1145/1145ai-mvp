# 1145ai threat model

**Owner:** Q2 (security) · **Review cadence:** weekly, see [weekly-audit.md](weekly-audit.md) · **Last reviewed:** 2026-10-03
against `main` @ `d126916` · **Merge-gate checklist:** [../checklists/security-review.md](../checklists/security-review.md)

This is a living document. It covers the MVP as it exists in the repo today: much of the code is still stubs
(`TODO(<lane>)`), so many rows describe what a lane **must** do when it lands, not only what is broken now.

> **Public repo.** This file never contains secret values, real phone numbers, tenant ids or tenant data. Findings
> say what to fix and where, not how to exploit it. Anything sensitive or still exploitable on a running system goes
> to the owner privately, not here.

## Contents
1. [Scope and assets](#1-scope-and-assets)
2. [Adversaries](#2-adversaries)
3. [Trust boundaries and identity sources](#3-trust-boundaries-and-identity-sources)
4. [STRIDE per flow](#4-stride-per-flow)
5. [Prompt-injection paths](#5-prompt-injection-paths)
6. [Abuse cases](#6-abuse-cases)
7. [Findings register](#7-findings-register)
8. [Accepted risks](#8-accepted-risks)
9. [Change log](#9-change-log)

---

## 1. Scope and assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tenant data (profile, hours, services, facts, customers, bookings, messages, conversations) | DynamoDB `t1145`, partition `TENANT#<tid>` | Cross-tenant leak or edit is the worst-case incident (ADR-0003). |
| Transcripts, KB docs, exports | S3 tenant bucket `tenants/<tid>/...` | Customer PII; 90-day retention target. |
| Route items (`NUMBER#`, `IDENTITY#`, `ENGINEAGENT#`, `SIGNUP#`, `REFERRAL#`) | DynamoDB, non-tenant partitions | Decide which tenant a call, chat or owner message belongs to. Tampering = full tenant takeover. |
| Service token signing keys, engine secret, onboarding service token, step-up secret | Secrets Manager / env | Anyone holding a signing key can mint any principal for any tenant. |
| Third-party credentials (Telnyx, LiveKit, Deepgram, ElevenLabs, Telegram, Stripe, Resend, Google OAuth) | Secrets Manager, GitHub secrets | Money (numbers, minutes, calls), impersonation of 1145 on Telegram/email. |
| Owner identity bindings (Cognito sub, Telegram user id) | `MEMBER#`, `IDENTITY#` | Bound identity can confirm changes (`CONFIRM 1234`). |
| Agent prompts and templates (`TEMPLATE#`, rendered instructions) | DynamoDB, repo | Control what every tenant's agent says. |
| Billing state and usage | `USAGE#`, Stripe | Revenue, suspensions, over-cap behaviour. |
| Build pipeline (GitHub Actions, OIDC deploy roles, auto-merge PAT, Claude OAuth token) | GitHub | Merged code deploys to AWS automatically. |
| Audit trail | S3 audit bucket (Object Lock, governance 365 d) | Non-repudiation for ops actions and state changes. |

## 2. Adversaries

| Actor | Capabilities | Typical goal |
|---|---|---|
| Anonymous caller | Dials any tenant number, spoofs caller ID, says anything | Get other customers' data, cancel bookings, make the agent say embarrassing things, burn minutes. |
| Anonymous web visitor | Has the public widget key, can script the chat and the token endpoint | Same as caller plus automation at scale; fill the calendar with fake bookings. |
| Malicious website content | Text on the owner's site or listings that we scrape | Inject instructions into the onboarding agent, get false "facts" verified. |
| Telegram stranger | Messages the shared bot | Free LLM usage, start onboardings, try to hijack someone's signup binding. |
| Curious or hostile tenant owner / staff | Valid Cognito login and bound Telegram for their own tenant | Read or change another tenant; abuse our phone account (toll fraud, harassment calls); jailbreak their own agent to impersonate a human. |
| Compromised internal component | A Lambda, the voice worker, or an agent runtime with its IAM role | Pivot across tenants, forge events, mint tokens. |
| Public GitHub user | Can open issues, comment, fork, open PRs (repo is public) | Get code merged, trigger CI with secrets, prompt-inject the Claude workflows. |
| Builder agent gone wrong | Write access to a branch, opens tagged PRs that auto-merge | Edit outside its lane, weaken checks, leak secrets into the repo. |

## 3. Trust boundaries and identity sources

The one rule (`.claude/skills/1145-tenant-isolation`): `tenantId` only comes from these sources.

| Source | Code today | Principal produced | Notes |
|---|---|---|---|
| Dialed number (SIP `sip.trunkPhoneNumber`) | `engines/livekit-agent/src/frontdesk/sip.py`, `resolver.py` → `services/tool-api/src/handlers/internal-resolve-number.ts` | `customer-agent` token, `ch=voice` | The resolver route is IAM (SigV4) only. See SEC-06 for where the attribute is read. |
| Widget key | `internal-resolve-widget.ts` (stub, T5), `customer-webchat-token.ts` (stub, C4) | `customer-agent`, `ch=webchat` | Widget key is public by design. It only identifies the tenant; it does not prove who the visitor is. |
| Verified channel identity | `services/channels/src/router.ts` (`IDENTITY#<channel>#<userId>`) | `admin-agent` (900 s) or `owner` (120 s, CONFIRM only) | Telegram is verified by the webhook secret header. WhatsApp is disabled in the MVP. |
| Cognito claim `custom:tenant_id` | `services/tool-api/src/lib/tenant-auth.ts`, pre-token trigger `services/auth/src/pre-token.ts` (stub, P5) | `owner` or `staff` | Only on `/dash/*` routes behind the JWT authorizer. |
| Engine secret + `system__agent_id` | `tenant-auth.ts` → `ENGINEAGENT#` route | `customer-agent` | ElevenAgents fallback only. One shared workspace secret. |
| Signed 1145 service token (HS256) | `packages/shared/src/tokens.ts` | Any principal in the claims | One key set shared by every issuer and verifier (SEC-07). |

Data plane isolation: the tool API assumes `TenantDataRole` with session tag `tenant_id`, and the role allows
`dynamodb:LeadingKeys` `TENANT#<tag>` and `TENANT#<tag>#*` plus S3 `tenants/<tag>/*`
(`infra/cdk/lib/data-stack.ts`). Tenant ids match `^t_[a-z0-9]{8,40}$` (`asTenantId`), and key segments reject `#`
(`packages/shared/src/keys.ts`), so the `#*` wildcard cannot reach a neighbouring tenant.

---

## 4. STRIDE per flow

Legend: **S**poofing · **T**ampering · **R**epudiation · **I**nformation disclosure · **D**enial of service ·
**E**levation of privilege. "Control" = what exists in code or contract today. "Gap" points at the findings register.

### F1. Inbound phone call
Telnyx DID → SIP → LiveKit → `frontdesk` worker → resolver (IAM) → tool API (tenant token) → DynamoDB (ABAC).

| | Threat | Control | Gap |
|---|---|---|---|
| S | Caller ID spoofed to look like a known customer | Caller ID is a hint only: `lookupCaller` returns first name + `hasUpcomingBooking`; reschedule/cancel need verification (`x-requires-verification`), eval `customer-spoofed-caller.yaml` | T1 verification not built yet. SEC-24 |
| S | Non-SIP participant supplies `sip.*` attributes | none | **SEC-06** |
| S | Direct SIP traffic to LiveKit that doesn't come from Telnyx | not configured yet (E1) | SEC-26 |
| T | Model passes another tenant's id | No tool takes a tenant id; token is closed over in `ToolsClient`; IAM LeadingKeys | — |
| T | Duplicate booking from LLM retry | `booking_idempotency_key(call_id, slot, service)` + transactional slot locks (`ddb-repo.ts book`) | — |
| R | Caller denies having booked | `booking.created` event with correlation id; transcript to S3 (E2 stub) | E2 must store transcripts. SEC-35 |
| I | Agent reveals other customers, revenue, config | Customer tool set has no read-other-customer tool; GUARDRAILS in `prompts.py`; eval `customer-injection.yaml` | SEC-04 |
| I | Owner's personal handoff number exposed to the model | LiveKit path keeps `transferTo` out of the model (`agent.py transfer_to_team`) | SEC-23 (ElevenAgents path) |
| I | Token leaks and is reused | Token never given to model; HS256, 1 h TTL | SEC-08 |
| D | Robocall floods, very long calls | `MAX_CALL_SECONDS` constant exists but is not enforced; spam filter is a stub (H3) | SEC-25 |
| D | Tool API slow or down → dead air | `handle()` maps errors to a "take a message" line; fillers | — |
| E | `customer-agent` calls admin tools | `principalMayCall` in `requireTenantContext` | — |
| E | Suspended / over-cap tenant still books via its token | Worker sets `message_only` client-side | SEC-08 (server doesn't enforce state) |

### F2. Customer web chat
Widget key → `POST /v1/webchat/token` (public) → LiveKit text room `chat-<tid>-<uuid>` → same worker → resolve widget
(IAM) → tool API.

| | Threat | Control | Gap |
|---|---|---|---|
| S | Visitor claims to be another tenant | Tenant resolved server-side from widget key; client never sends a tenant id (contract) | — |
| S | Visitor sets participant attributes that look like SIP caller ID | none | **SEC-06** |
| T | Visitor supplies a victim's phone in a booking | `createBooking` takes body phone for non-voice channels | SEC-24 |
| I | Room name guessable → join someone else's chat | Room name server-generated with UUID (contract) | C4 must keep room join grants to one room, short TTL |
| D | Scripted token minting, LLM cost, calendar filled with fake bookings | Contract says "rate limited per IP and per widget key"; nothing in `channels-stack.ts` yet | SEC-25 |
| E | Web chat token grants more than chat (publish audio, admin) | not built (C4) | SEC-06 |

### F3. Owner onboarding over Telegram
Telegram → `/telegram` (secret header) → SQS FIFO → router → onboarding agent (AgentCore) → onboarding API (service
token) → Step Functions. Signup link → Cognito (Google) → `/signup/callback` → pending binding → "reply YES".

| | Threat | Control | Gap |
|---|---|---|---|
| S | Forged Telegram updates | `verifyTelegramSecret` (constant-time) before parsing; private chats only; bots ignored | — |
| S | Forwarded signup link binds a stranger's Google account | Single-use 32-byte token, SHA-256 stored, 15 min TTL, conditional consume; reverse confirmation (Add-5) | **SEC-20** (YES must be deterministic) |
| S | Model redirects tools to another onboarding | Tools are closures over `onboarding_id`; `test_tool_binding.py` | SEC-22 (static service token) |
| T | Scraped facts become "verified" via the model | Facts stored `verified=false` with injection flags (`sanitize.ts`) | **SEC-05** |
| R | Owner says they never approved a fact or started provisioning | Step Functions history; onboarding records | Decisions should be logged with the channel message id (D3, D1) |
| I | Signup token leaks via link previews, Referer, logs | Token never shown to the agent | SEC-20 |
| D | Strangers spam the bot → onboarding records + LLM calls | FIFO per user, DLQ after 5 | SEC-25 |
| E | Onboarding agent triggers spending (number purchase) on its own | Card on file before ordering (D9); provisioning requires confirmed identity (409) | SEC-05, SEC-22 |

### F4. Owner web chat, dashboard and realtime
Cognito (Google, basic scopes) → `/dash/v1/...` (JWT authorizer) and `/v1/owner-chat/messages` → AppSync Events
`/tenants/<tid>/live`, `/owners/<sub>/chat`, `/ops/fleet`.

| | Threat | Control | Gap |
|---|---|---|---|
| S | User edits their own `custom:tenant_id` / `custom:role` | Client `writeAttributes` = email only; pre-token trigger sets claims (P5 stub) | SEC-16 |
| S | Auth code interception via a dev callback URL in prod | none | SEC-16 |
| E | Missing or unknown role becomes `owner` | none | **SEC-09** |
| E | Staff apply changes and edit prices | Router lets only owners CONFIRM | **SEC-10** |
| I | Subscribe to another tenant's live channel | `ONLY_OWN(2, 'custom:tenant_id')` subscribe handler | — |
| I | Any signed-in user subscribes to `/ops/fleet` | none | **SEC-15** |
| T | Cognito user publishes fake live events | Publish auth mode IAM only | — |
| D | Owner chat flood | FIFO per user | SEC-25 |

### F5. Owner copilot and change confirmation
Router → admin agent (token `admin-agent`) → `proposeChange` → owner replies `CONFIRM 1234` → router mints `owner`
token (120 s) → `applyChange`. Price changes also need step-up.

| | Threat | Control | Gap |
|---|---|---|---|
| E | Admin agent applies changes itself | No apply tool (`test_admin_agent_has_no_apply_tool...`); `ADMIN_AGENT_TOOLS` lacks `applyChange` | — |
| T | Owner confirms a change that differs from what they were shown | none yet (T2 stub) | **SEC-21** |
| S | Staff or stranger confirms | Router checks `route.role === 'owner'` and an active tenant | — |
| T | Code brute force or replay | 4 digits, "unique per tenant, 30-min TTL" (T2 TODO) | SEC-21 |
| I | Stored customer text in conversations steers the copilot | `<data>` wrapping in `admin/tools.py`; system prompt rule | SEC-04 |
| E | Price change without step-up | `x-requires-step-up: [priceCents]` in contract; not built (T4) | SEC-21 |

### F6. Provisioning workflow
Step Functions: payment check → (number: search → order → bind) ‖ (scrape → owner confirms facts) ‖ (profile) →
render agent → owner names agent → smoke call → activate.

| | Threat | Control | Gap |
|---|---|---|---|
| T | Retry buys a second number | `OrderState` conditional write on `ORDER#<onboardingId>` | **SEC-18** (failure between order and state write) |
| I | Scraper reaches internal addresses | none yet (D6) | **SEC-17** |
| T | Scraped or owner free text lands in the system prompt | `sanitize.ts` keeps scraped text as candidates; render step not built (D7) | SEC-33 |
| E | Smoke call or handoff targets arbitrary or premium numbers | none | **SEC-19** |
| R | Who started provisioning | Execution name = `onboardingId` | — |
| D | Executions wait days on task tokens | 3-day task timeout, 7-day state machine timeout | — |

### F7. Post-call, usage and billing metering
EventBridge `call.ended` → post-call Lambda → transcript (S3) → Bedrock analysis → CRM upsert → usage counter →
Stripe usage; `over_cap` flips the number route.

| | Threat | Control | Gap |
|---|---|---|---|
| S | Forged `call.ended` from another producer | Rule matches `detailType` only | **SEC-13** |
| I | `transcriptKey` points at another tenant's transcript | Lambda can read `tenants/*/transcripts/*` | **SEC-14** |
| T | Transcript text steers the analysis model | Comment says "quoted data, JSON only" (G1 stub) | SEC-14 |
| T | Double-counted usage | `alreadyProcessed` conditional put on `POSTCALL#<callId>`; Stripe idempotency key = callId (G2) | — |
| D | Inflated usage pushes a tenant over cap | Same as SEC-13 | SEC-13 |

### F8. Notifications
EventBridge → dispatcher → Telegram, email (Resend), web push (VAPID), phone call for urgent handoffs.

| | Threat | Control | Gap |
|---|---|---|---|
| T | Customer text in emails/Telegram used for phishing the owner | none yet (C6) | SEC-32 |
| D | Caller marks everything urgent → repeated calls to the owner | none | SEC-19, SEC-25 |
| I | Notification sent to the wrong owner | Dispatcher reads identity routes (C6) | C6 must resolve recipients from `MEMBER#` of the event's tenant only |

### F9. Billing and control plane
Stripe → `/stripe/webhook` → `actionForStripeEvent` → `setTenantState` (+ audit). Console API behind IAM.

| | Threat | Control | Gap |
|---|---|---|---|
| S | Forged Stripe events | `verifyStripeSignature` (HMAC, 300 s tolerance, constant-time, multiple v1) | Dedupe by event id (H1) |
| T | Billing event re-activates a tenant suspended for abuse | none | SEC-29 |
| R | Ops actions without trace | `setTenantState` requires a reason code and writes audit; Object Lock bucket | H1 audit writer is a stub |
| E | Console reachable by tenants | IAM authorizer on `/console/{proxy+}` | — |

### F10. Referrals
`/r/{code}` → click log → onboarding; reward after the referred tenant's first paid invoice (H3).

| | Threat | Control | Gap |
|---|---|---|---|
| S | Self-referral with throwaway accounts | Reward only after first paid invoice, one per verified tenant (H3 design) | H3 must dedupe on card fingerprint / Stripe customer, not Google account |
| D | Click-log flooding | none | SEC-25 |
| T | Open redirect | Redirect target fixed to `https://app.1145.ai/start?ref=<code>`; code pattern-checked | C5 must not take the target from input |

### F11. Build and deploy supply chain
Agents push branches → PR `[1145:<ID>]` → CI (ownership, contracts-guard, tests, style, secrets-scan, claude-review) →
auto-merge (PAT) → `deploy.yml` (OIDC) → dev → e2e → prod (environment approval).

| | Threat | Control | Gap |
|---|---|---|---|
| E | PR edits the ownership checker or its issue map in the same PR | CI ownership check, CODEOWNERS on `/.github/`, `/contracts/`, `/packages/shared/` | **SEC-01** |
| E | Public commenter or bot drives the Claude workflow with write permissions | `@claude` filter only; `allowed_bots: "*"` | **SEC-02** |
| T | LLM merge gate persuaded by PR content | claude-review is one of nine required checks | SEC-02 |
| T | Third-party action changes underneath us | Actions pinned by tag; trufflehog by branch | SEC-03 |
| I | Secrets committed | trufflehog `--only-verified` | SEC-03 (self-generated secrets aren't "verifiable") |
| E | Fork PR or non-main branch deploys | `deploy.yml` requires `workflow_run.event == 'push'` on `main`; OIDC `sub` scoped to environment | SEC-34 |
| R | Who merged what | Squash merges, PR history, Linear | — |

---

## 5. Prompt-injection paths

Rule: scraped text, transcripts, owner free text and tool results are data. The table lists every path from
untrusted text to a model, what the model could do with it, and what limits the damage.

| # | Untrusted source | Reaches | Worst realistic impact | Controls today | Findings |
|---|---|---|---|---|---|
| PI-1 | Caller speech (STT) | Voice agent (Haiku) | Agent says false prices/policies; books/takes messages (all allowed anyway); tries to cancel | Tool allowlist + server authz; verification for cancel/reschedule; GUARDRAILS appended **after** tenant instructions; disclosure line spoken by code (`session.say`), not the model; evals | Price/policy rule is prompt-only: T0 could return prices only via tools so there is nothing to invent from |
| PI-2 | Web chat text | Same agent in text mode | As PI-1, scripted at scale | As PI-1 | SEC-06, SEC-25 |
| PI-3 | Owner's website, listings (scraped) | Onboarding agent via `facts_to_confirm`; after approval, the voice agent via `lookup_business_info` | False "facts" verified and spoken to every caller; onboarding agent coaxed into calling tools | `sanitize.ts` flags instruction-like passages; `verified=false`; customer agent only sees verified facts | **SEC-04**, **SEC-05**, SEC-17 |
| PI-4 | Customer messages, booking names, transcripts (stored) | Admin agent (`recent_conversations`, `summary_report`), post-call analysis, CRM, notifications | Copilot proposes a change the owner confirms on autopilot; misleading summaries; phishing text in owner notifications | Admin agent can only propose; CONFIRM is deterministic in the router; `<data>` wrapping | SEC-04, SEC-14, SEC-21, SEC-32 |
| PI-5 | Owner free text (hours, services, agent name, business description) | Parse-profile LLM (D2); rendered instructions (D7) → every call's system prompt | Owner jailbreaks their own agent (claims to be human, drops disclosure, insults callers) | Agent name capped at 40 chars; structured parse with read-back | SEC-33 |
| PI-6 | Telegram `first_name` / display name | Agent payload `displayName` | Injection via profile name | Not used in prompts yet | A1/A2: wrap as data if ever used |
| PI-7 | Tool results (availability, booking, handoff, knowledge passages) | Voice + admin agents | Tool result text treated as instructions | `as_data` wrapping | SEC-04, SEC-23 |
| PI-8 | Stripe objects (customer names, descriptions) | Notifications, admin summaries | Phishing or injection via billing metadata | Deterministic mapping, no agent (Change-12) | C6: escape before display |
| PI-9 | PR titles, diffs, CI logs, issue comments | `claude-review` merge gate, `@claude` workflow | Malicious PR approved; code written by a prompt-injected agent with write access | Deterministic checks also required; fork PRs get no secrets | **SEC-02**, SEC-01 |

Design guidance for every lane:
- Wrap untrusted text with a boundary the text can't forge (SEC-04), and say where it came from (`source=`).
- Anything that changes what customers hear (facts, prompts, hours, prices) or spends money is a **deterministic owner
  action**, never a model's judgment alone. The model may *propose*; code *applies* after an explicit owner signal
  bound to the exact diff.
- Generate confirmation text from structured data in code, not from model output.
- Prefer returning structured fields over prose from tools; never return secrets, owner phone numbers or ids the
  model doesn't need.

## 6. Abuse cases

| # | Abuse | Who pays / who's hurt | Controls today | Needed (owning lane) |
|---|---|---|---|---|
| AB-1 | Robocall or bot flood to a tenant number burns minutes and LLM/TTS spend | 1145 margin, tenant cap | Usage counter + `over_cap` (G2), message-only mode | Enforce max call length (E3), per-caller-ID and per-tenant concurrency caps, spam-call filter (H3) |
| AB-2 | Scripted web chat sessions (LLM cost) and fake bookings filling the calendar | Tenant loses real customers | Contract mentions rate limits | Rate limit token endpoint per IP + widget key (C4), per-room booking cap and per-day booking cap per contact (T0/T6), alert the owner on bursts |
| AB-3 | Telegram bot spam: every unknown user starts an onboarding and an LLM call | 1145 | none | Per-identity and global onboarding caps, cheap canned reply after N messages without progress (C1) |
| AB-4 | Toll fraud: handoff, smoke call or urgent notification dials premium-rate or international numbers | 1145 Telnyx bill | none | Allow-list NANP non-premium destinations, Telnyx outbound profile limits, per-tenant daily outbound caps (D8, C6, E3, E1) |
| AB-5 | Harassment: our system calls a victim's number (owner phone typed wrong or on purpose) | Victim, 1145 reputation | none | Verify the owner phone before calling it repeatedly; cap smoke-call retries; urgent-call notifications rate-limited (D8, C6) |
| AB-6 | Free-trial farming: new Google account per trial, card-on-file with prepaid cards | 1145 | Card before number (D9), trial minute caps (H3) | Card fingerprint dedupe, one trial per card/Stripe customer (D9, H3) |
| AB-7 | Referral fraud: self-referrals | 1145 | Reward after first paid invoice (H3 design) | Dedupe by card fingerprint and business identity (H3) |
| AB-8 | Number hoarding: start many onboardings to buy numbers then abandon | 1145 | Card on file; idempotent order per onboarding | Release numbers from abandoned onboardings after N days; cap numbers per Stripe customer (D5, H3) |
| AB-9 | Owner uses their agent to impersonate a person or another business | Callers, 1145 legal | Disclosure line spoken by code | Disclosure from a fixed template, not owner-editable; business name checks for well-known brands (D7, H2) |
| AB-10 | Caller-ID enumeration to learn customers' first names | Customers' privacy | Minimal lookup (first name + boolean) | Accepted (see §8); keep it to first name only, never on web chat (SEC-06) |
| AB-11 | Stolen owner Telegram account confirms changes | Tenant | Price changes need dashboard step-up | Notify the owner on another channel (email) when changes are applied (C6) |

---

## 7. Findings register

Severity: **High** = cross-tenant, money or merge-pipeline compromise likely once the code is live; **Medium** =
needs a second failure or affects one tenant; **Low** = hardening. Status values: `open`, `in progress`, `fixed`
(with PR), `accepted`. Lanes come from `orchestration/issues.ts`. Q2 doesn't edit other lanes' files: each owning
lane picks up its rows (via Linear or a change request), and Q2 re-checks them in the weekly sweep.

| ID | Sev | Lane(s) | Where | Finding | Fix | Status |
|---|---|---|---|---|---|---|
| SEC-01 | High | P3, P1 | `scripts/ci/check-ownership.ts`, `scripts/ci/lib.ts`, `orchestration/issues.ts`, `.github/CODEOWNERS` | The ownership and contract checks run the PR's own copy of the checker and of the issue→owns map. A PR can widen its own ownership or weaken the check and still pass. CODEOWNERS doesn't cover `/scripts/ci/` or `/orchestration/`. | Run the checker and read `issues.ts` from `BASE_SHA` (e.g. a separate checkout of the base), not the PR head. Add CODEOWNERS entries for `/scripts/ci/`, `/orchestration/issues.ts`, `/orchestration/ownership.ts`. | open |
| SEC-02 | High | P3 | `.github/workflows/claude.yml`, `claude-review.yml`, `ci-failure-router.yml` | Repo is public. `claude.yml` runs on any comment containing `@claude` with `contents: write` and `allowed_bots: "*"`. `claude-review.yml` itself says "Private repo only" and interpolates the PR title into the prompt; its verdict is a required check. `ci-failure-router` posts untrusted log tails with an `@claude` mention (today this doesn't trigger a run because it uses `GITHUB_TOKEN`). | Gate `claude.yml` on `author_association` in OWNER/MEMBER/COLLABORATOR; replace `allowed_bots: "*"` with the named agent bots; pass PR title/body via files and tell the reviewer they're data; keep deterministic checks authoritative; never switch the failure router to a PAT/App token without stripping the log tail. Consider making the repo private until this lands. | open |
| SEC-03 | Medium | P3 | `.github/workflows/ci.yml` (`secrets-scan`), all workflows | `trufflesecurity/trufflehog@main` is unpinned; other actions are pinned by tag only. `--only-verified` can't detect self-generated secrets (HMAC keys, webhook secrets, service tokens). | Pin all third-party actions to commit SHAs. Add an unverified/entropy pass (trufflehog without `--only-verified`, with an allowlist) or custom detectors for our secret names. | open |
| SEC-04 | High | A1, E4, E5, D6 | `agents/common/api.py` `as_data`, `engines/livekit-agent/src/frontdesk/prompts.py` `as_data`, `services/provisioning/src/lib/sanitize.ts` | The `<data>` wrapper doesn't neutralise a closing `</data>` inside the content (JSON encoding doesn't escape `<` or `/` either), so untrusted text can end the data block early. `sanitize.ts` role-tag pattern doesn't include `data`. | Escape `<`/`>` (or at least `</data`) in wrapped content, or use a random per-call boundary; add `source` attribute. Add `data` to the role-tag pattern. Add a test with a closing tag in the payload. | open |
| SEC-05 | High | A2, D3 | `agents/onboarding/tools.py` `confirm_facts`, `services/provisioning/src/api/facts.ts` | The onboarding model reads scraped facts (`facts_to_confirm`) and also decides which ids get approved (`confirm_facts`). Injected page text can push it to approve everything, and approved facts are spoken to callers. | D3 server rules: only approve ids that were shown in the latest listing; refuse agent-path approval of `flags`-bearing facts (owner must approve those in the dashboard); record the owner message id per decision. A2: one fact per question, approval only on an explicit owner yes. | open |
| SEC-06 | High | E5, C4 | `engines/livekit-agent/src/frontdesk/worker.py` (`sip_info_from_attributes(dict(participant.attributes))`), `services/channels/src/customer-webchat-token.ts` | The worker takes `sip.*` attributes from whichever participant joins first and doesn't check that it's a SIP participant. If a web chat token lets the visitor set its own attributes, a visitor could present any caller ID and get the caller-lookup answer for that number. | E5: trust `sip.*` only when `participant.kind` is SIP; resolve chat rooms by widget key from server-set room metadata. C4: web chat tokens with no `canUpdateOwnMetadata`, text only, one room, short TTL. Add a test for both. | open |
| SEC-07 | Medium | C0 | `packages/shared/src/tokens.ts`, `services/tool-api/src/lib/tenant-auth.ts` | One HS256 key set for every issuer: anything that can mint (resolver, router, and every tool-api Lambda that reads the secret) can mint `owner` for any tenant. `prn`, `ch` aren't validated against enums; no `iss`, no max TTL per principal, no future-`iat` check. | Add `iss`; per-issuer keys; verifier maps issuer → allowed principals (resolver → `customer-agent` only, router → `admin-agent`/`owner`); cap TTL per principal; validate enums. Tool-api verifier functions shouldn't hold minting keys. | open |
| SEC-08 | Medium | T5 | `services/tool-api/src/handlers/internal-resolve-number.ts` | Call token TTL is 3600 s while calls are capped at 15 min; token is minted with full `customer-agent` rights even when the route is `suspended`/`over_cap` (only the worker enforces message-only). | TTL ≈ max call + margin (e.g. 20 min); add a `state` claim or check route state in tool-api for booking tools. | open |
| SEC-09 | Medium | T0 | `services/tool-api/src/lib/tenant-auth.ts:26` | Cognito path maps any role that isn't `staff` (including missing) to `owner`. Fails open. | Map `owner`→owner, `staff`→staff, anything else → 403. Test it. | open |
| SEC-10 | Medium | C0 | `packages/shared/src/tenant-context.ts:47` | `staff` gets `OWNER_TOOLS`, including `applyChange`, `updateHours`, `updateService`. Contract `x-principals` lists only `owner` for those. Dashboard staff can apply. | Add a `STAFF_TOOLS` list matching the contract; contract change via C0. | open |
| SEC-11 | Medium | T7 | `infra/cdk/lib/api-stack.ts:64`, `:71` | Every tool-api Lambda gets `grantRouteRead` (NUMBER#, IDENTITY#, ENGINEAGENT#, SIGNUP#, REFERRAL#); ADR-0003 says resolver role only. Public `/v1/tools/*` routes have no stage throttling. | Grant route read only to resolvers and the engine-agent lookup path; add HTTP API stage throttling (and T6 per-tenant limits). | open |
| SEC-12 | Medium | C0, P4 | `infra/cdk/lib/data-stack.ts` `TenantDataRole` | Trust is the account root with session tags: any principal in the account allowed `sts:AssumeRole` on it picks any `tenant_id`. | Trust only the tool-api function roles (`aws:PrincipalArn`), require `aws:RequestTag/tenant_id` and `aws:TagKeys` = `[tenant_id]`, deny tag values with `*`, `?` or `#`. P4: CDK assertion tests for these conditions. | open |
| SEC-13 | Medium | C0, G3, P6, C6 | `infra/cdk/lib/events-stack.ts`, `postcall-stack.ts:18`, `realtime-stack.ts:43`, `notifications-stack.ts:19` | Rules match `detailType` only and producers get unconditioned `PutEvents`; any producer can emit `call.ended`, `booking.*`, `tenant.*` for any tenant (usage inflation, fake owner notifications). | Match `source` per event type (e.g. `call.ended` only from the voice source); add an `events:source` condition to each producer's grant. | open |
| SEC-14 | Medium | G3, G1 | `services/post-call/src/handler.ts`, `infra/cdk/lib/postcall-stack.ts` | Post-call reads `tenants/*/transcripts/*` and uses `transcriptKey` from the event as-is. Analysis output (summary) is shown to the owner and the copilot. | Reject keys that don't start with `tenants/<envelope tenantId>/transcripts/`; G1: schema-validate output, cap lengths, strip URLs. | open |
| SEC-15 | Medium | P6 | `infra/cdk/lib/realtime-stack.ts:37` | `ops` namespace has no subscribe handler; default subscribe auth is the user pool, so any signed-in user can subscribe to `/ops/fleet`. | Add an `onSubscribe` that requires the ops Cognito group. | open |
| SEC-16 | Medium | P5, P4 | `infra/cdk/lib/auth-stack.ts:32`, `services/auth/src/pre-token.ts` | `http://localhost:3000/auth/callback` is allowed in every stage, including prod. `tenant_id`/`role` are mutable custom attributes protected only by this client's `writeAttributes`. | Localhost callback only for dev; PKCE in the app; pre-token must derive claims from `MEMBER#` and override, never echo attributes; P4 test that every app client excludes `custom:*` from write attributes. Don't map any IdP attribute to `custom:tenant_id`/`role`. | open |
| SEC-17 | Medium | D6 | `services/provisioning/src/steps/scrape-knowledge.ts` | Owner-supplied URLs are fetched server-side (not built yet): SSRF risk. | http(s) only; resolve and block loopback, private, link-local and metadata ranges, re-check after each redirect; size and time caps (10 pages, 5 s already planned); no cookies/auth headers. | open |
| SEC-18 | Medium | D5 | `services/provisioning/src/steps/order-number.ts` | If Telnyx accepts the order but `state.put` throws, the `catch` moves on to the next candidate and buys a second number. | Only catch order errors in the loop; if the state write fails after a successful order, rethrow so the retry hits `state.get`/reconciliation by `customer_reference`; daily orphan-number report. | open |
| SEC-19 | Medium | D8, C6, E3, E1 | `smoke-call.ts`, `notifications/src/dispatcher.ts`, `call_control.py`, Telnyx/LiveKit outbound setup | Outbound calls go to owner-supplied numbers (smoke call, handoff transfer, urgent notification): toll fraud and harassment risk. | Destination allow-list (US/CA, no premium/short codes) in code **and** in the Telnyx outbound profile; per-tenant daily outbound caps; verify the owner phone before repeated calls. | open |
| SEC-20 | Medium | C1, D4, C2 | `services/channels/src/router.ts`, `services/provisioning/src/lib/signup-token.ts`, `api/signup-callback.ts`, `telegram-send.ts` | The reverse confirmation asks the owner to "reply YES", but the router only handles `CONFIRM <code>`; a YES would reach the onboarding model. Signup links in Telegram get link previews by default. | Router handles the binding YES/NO deterministically against the pending binding; send signup links with link previews disabled; consume the token only after Cognito auth succeeds; `Referrer-Policy: no-referrer` on the signup pages. | open |
| SEC-21 | Medium | T2, T4, A3 | `admin-propose-change.ts`, `admin-apply-change.ts`, `admin-update-service.ts`, `agents/admin/tools.py` | Not built yet. The summary the owner confirms must match what gets applied; codes need limits; price step-up is unimplemented. | T2: summary generated in code from the structured diff; apply re-validates; code single-use, 30-min TTL, invalidate after ~5 wrong attempts; bind to tenant. T4: step-up token for `priceCents`. A3: relay the server summary verbatim. | open |
| SEC-22 | Medium | A1, D1 | `agents/onboarding/app.py:22`, onboarding API | One static `ONBOARDING_SERVICE_TOKEN` from env authorises every `onboardingId`; the path id is the only binding. | Router mints a short-lived signed token with an `onb` claim per invocation; onboarding API checks path id == claim. Load secrets from Secrets Manager. | open |
| SEC-23 | Medium | T0, E7 | `services/tool-api/src/handlers/request-handoff.ts:14` | `transferTo` (owner's number) is returned in the tool response. Fine on LiveKit (kept out of the model) but on the ElevenAgents path the response goes to the model. | Return an opaque transfer reference; resolve the number in the engine/call-control layer. | open |
| SEC-24 | Low | T0, G2 | `create-booking.ts`, CRM upsert | On web chat the model supplies the phone and name; a later caller-ID lookup could greet someone with a name another visitor typed. | Store `phoneVerified=false` for non-carrier phones; caller lookup and CRM merge only on carrier-verified numbers; sanitize names. | open |
| SEC-25 | Medium | E3, H3, T6, C1, C4, C5 | call control, abuse, rate limiting, router, token, referral | Cost and DoS controls are mostly unbuilt: no enforced max call length, no per-caller or per-IP limits, no onboarding caps, no throttling on public routes. | See AB-1 to AB-3; add API Gateway throttling on every public API as a floor. | open |
| SEC-26 | Medium | E1 | `scripts/livekit/**`, `scripts/telnyx/**`, `infra/cdk/lib/voice-stack.ts` | Inbound SIP trunk restrictions aren't defined yet. | LiveKit inbound trunk accepts only Telnyx signalling addresses (and auth); dispatch only for numbers we own. | open |
| SEC-27 | Low | E5 (and Q2 checklist) | `worker.py:60` | Logs tenant id and call id at INFO; the checklist says no tenant ids in INFO logs. | Owner decision: either allow tenant ids in structured logs (useful for ops) and update the checklist, or hash them. Q2 will update the checklist after the decision. | open |
| SEC-28 | Low | E5 | `resolver.py:47` | `RESOLVER_MODE=static` (spike) routes every call to one tenant if left set. | Refuse static mode unless the stage is dev. | open |
| SEC-29 | Low | H1 | `services/control-plane/src/stripe.ts:23` | `invoice.paid` → `active` would lift an ops/abuse suspension. No event-id dedupe yet. | Keep the suspension reason; billing events only clear billing suspensions; dedupe by Stripe event id; map Stripe customer → tenant from our record. | open |
| SEC-30 | Low | E7 | `engines/elevenlabs-adapter/src/signature.ts:5` | 30-minute replay window, no dedupe. | 5 min tolerance and dedupe on conversation id. | open |
| SEC-31 | Low | C1 | `services/channels/src/whatsapp-webhook.ts:32` | Verify-token compare isn't constant time. Disabled in MVP (ADR-0005). | Use `safeEqual` before enabling WhatsApp in Phase 2. | open |
| SEC-32 | Low | C6 | `services/notifications/src/dispatcher.ts` | Customer text (message body, names) goes into owner email/Telegram. | Escape HTML/Markdown, no auto-linking, label it as caller-provided. | open |
| SEC-33 | Low | D7 | `services/provisioning/src/steps/render-agent.ts`, `frontdesk/prompts.py build_instructions` | Rendered tenant instructions are concatenated into the voice system prompt. | Build them only from structured, validated fields; facts go through the knowledge tool, not the prompt; disclosure line from a fixed template. | open |
| SEC-34 | Low | P1, P2 | GitHub environments, `deploy.yml` | OIDC roles are scoped by environment; safety relies on environment settings that live outside the repo. The `workflow_run.event == 'push'` guard is load-bearing. | `dev`/`prod` environments restricted to `main`; prod requires reviewers; keep the push guard (comment it). | open |
| SEC-35 | Low | E2, C0 | `events.py`, `data-stack.ts`, `events-stack.ts` | Transcript expiry relies on the object tag `kind=transcript`; event archive keeps summaries (PII) for 30 days. | E2 tags transcript objects on upload; C0 confirms archive retention fits the privacy policy or excludes `conversation.message`. | open |

## 8. Accepted risks

| Risk | Why accepted | Revisit when |
|---|---|---|
| Caller ID is spoofable, so lookup reveals a first name and whether a booking exists | Personal greeting is a product requirement; the data is minimal and nothing changes without verification | Any change that returns more than first name + boolean |
| Widget key is public | It identifies a tenant, like a phone number; abuse is handled by rate limits (SEC-25) | If widget keys ever unlock non-public data |
| Owner can make their own agent say almost anything | It's their business; guardrails, the code-spoken disclosure and the tool allowlist bound the damage | Complaints, or regulated verticals (healthcare is waitlisted) |
| Single voice worker and post-call Lambda serve all tenants (no per-tenant IAM inside them) | One process per call; tenant comes from the resolver; transcript keys are tenant-prefixed | If per-tenant model or data keys are introduced |
| Builder agents have write access and PRs auto-merge on green | Speed of the parallel build; CODEOWNERS on contracts/shared/isolation | SEC-01 and SEC-02 must be fixed for this to stay acceptable |

## 9. Change log

| Date | Change | By |
|---|---|---|
| 2026-10-03 | First version: STRIDE for 11 flows, 9 injection paths, 11 abuse cases, 35 findings. Weekly sweep started. | Q2 |
