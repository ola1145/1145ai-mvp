# DynamoDB single table `t1145` — key design

| Entity | PK | SK | Notes |
|---|---|---|---|
| Tenant profile | `TENANT#<tid>` | `PROFILE` | name, type, timezone, state, engine, engineRef, templateVersion, channels{sms,whatsapp,...} |
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
| **Route: number** | `NUMBER#<e164>` | `ROUTE` | tid, engine, state — resolver role only |
| **Route: identity** | `IDENTITY#<channel>#<channelUserId>` | `ROUTE` | tid or onboardingId, role — resolver role only |
| **Route: engine agent** | `ENGINEAGENT#<engine>#<agentId>` | `ROUTE` | tid — resolver role only |
| **Signup token** | `SIGNUP#<sha256(token)>` | `TOKEN` | onboardingId, channel identity, exp, consumed — TTL |
| **Referral** | `REFERRAL#<code>` | `OWNER` | referrer tid; clicks counted in `REFCLICK#<code>` |
| **Agent template** | `TEMPLATE#<name>` | `V#<semver>` | prompt, tool list, canary %, status |

GSI1 (`GSI1PK`, `GSI1SK`): booking by id; customer by phone (`TENANT#<tid>#PHONE` / `<e164>`).

IAM: tenant role → `dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/tenant_id}` (base table and GSI1PK prefix
via key design: GSI1PK always starts with `TENANT#<tid>#`). Resolver role → `NUMBER#*`, `IDENTITY#*`, `ENGINEAGENT#*`,
`SIGNUP#*`, `REFERRAL#*` only.
