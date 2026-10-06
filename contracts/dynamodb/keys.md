# DynamoDB single table `t1145` — key design

Additive only: new items and attributes may be added (via a change request to C0); existing keys and attributes are
never renamed or removed in the MVP.

| Entity | PK | SK | Notes |
|---|---|---|---|
| Tenant profile | `TENANT#<tid>` | `PROFILE` | name, type, timezone, state, engine, engineRef, templateVersion, channels{sms,whatsapp,...}; optional `handoffWindow` (same shape as `HOURS`: `{ timezone, weekly: [{day, open, close}], closedDates? }`; transfers only inside it, else inside business hours; CR T0-1) |
| Business hours | `TENANT#<tid>` | `HOURS` | BusinessHours schema |
| Service | `TENANT#<tid>` | `SERVICE#<sid>` | name, durationMin, priceCents, active |
| Knowledge fact | `TENANT#<tid>` | `FACT#<fid>` | text, source, verified (owner-confirmed), flaggedInstructionLike |
| Customer | `TENANT#<tid>` | `CUSTOMER#<cid>` | name, phones[], email, notes, lastSeen |
| Booking | `TENANT#<tid>` | `BOOKING#<startIso>#<bid>` | GSI1PK `TENANT#<tid>#BID`, GSI1SK `<bid>` for lookup by id |
| Slot lock | `TENANT#<tid>` | `SLOT#<resource>#<slotIso>` | written in the same transaction as the booking; condition `attribute_not_exists(PK)` |
| Conversation | `TENANT#<tid>` | `CONV#<startIso>#<convId>` | channel, summary, sentiment, transcriptKey |
| Message (taken) | `TENANT#<tid>` | `MSG#<iso>#<mid>` | |
| Idempotency | `TENANT#<tid>` | `IDEMP#<key>` | stored response, TTL 24 h |
| Usage | `TENANT#<tid>` | `USAGE#<yyyy-mm>` | atomic counter of billable seconds |
| Owner/staff | `TENANT#<tid>` | `MEMBER#<sub>` | role owner/staff, bound identities |
| Pending change | `TENANT#<tid>` | `CHANGECODE#<4 digits>` | proposeChange record (changeId, kind, payload, summary, requiresStepUp, status pending/applied, expiresAt, proposedBy). The code is the sort key, so a conditional put keeps codes unique among open changes; `ttl` = expiry + 1 day (CR T2-1) |
| Change audit | `TENANT#<tid>` | `AUDIT#<iso>#<changeId>` | one entry per applied change, written in the same transaction as the status flip (CR T2-1) |
| **Route: number** | `NUMBER#<e164>` | `ROUTE` | tid, engine, state — resolver role only |
| **Route: identity** | `IDENTITY#<channel>#<channelUserId>` | `ROUTE` | `role` (`owner`, `staff`, `onboarding`), `tid` or `onboardingId`, tenant state in `tenantState` (`provisioning`, `active`, `suspended`). Provisioning keeps `onboardingId` until activation flips the route to the tenant (CR C1-1) — resolver/router roles only |
| **Route: engine agent** | `ENGINEAGENT#<engine>#<agentId>` | `ROUTE` | tid — resolver role only |
| **Signup token** | `SIGNUP#<sha256(token)>` | `TOKEN` | onboardingId, channel identity, exp, consumed — TTL |
| **Referral** | `REFERRAL#<code>` | `OWNER` | `referrerTid` (readers also accept `tid`); clicks counted in `REFCLICK#<code>` |
| **Onboarding** | `ONBOARDING#<onboardingId>` | `STATE` | status (`started`, ...), channel, channelUserId, displayName, optional `referralCode` (`^[A-Za-z0-9_-]{4,64}$`) and `referrerTid` (looked up from `REFERRAL#<code>`, never from message text), createdAt. Written in one transaction with the IDENTITY route, conditional `attribute_not_exists(PK)` on the route (CR C1-1) — router role only |
| **Message dedup** | `MSGDEDUP#<channel>#<sha256(channelUserId + "\n" + channelMessageId)>` | `SEEN` | status `processing` (150 s lease) then `done`; TTL 2 days. A replayed message id never invokes an agent twice (CR C1-1) — router role only |
| **Agent template** | `TEMPLATE#<name>` | `V#<semver>` | prompt, tool list, canary %, status |

GSI1 (`GSI1PK`, `GSI1SK`): booking by id; customer by phone (`TENANT#<tid>#PHONE` / `<e164>`).

IAM: tenant role → `dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/tenant_id}` (base table and GSI1PK prefix
via key design: GSI1PK always starts with `TENANT#<tid>#`). Resolver role (`DataStack.grantRouteRead`, which also grants
KMS decrypt on the table key) → `NUMBER#*`, `IDENTITY#*`, `ENGINEAGENT#*`, `SIGNUP#*`, `REFERRAL#*` only. The router's
own role additionally writes `IDENTITY#*`, `ONBOARDING#*`, `MSGDEDUP#*` (granted in its stack).
