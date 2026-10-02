# Implementation plan — MVP deploy

Four waves, four human gates. Lanes inside a wave run in parallel. Durations are estimates for one founder
orchestrating AI lanes; the long poles are third-party approvals, not code.

```
G0 approve plan ─► WAVE 0 (3–4 days) ─► G1 contracts + spike ─► WAVE 1 (≈2 weeks) ─► G2 end-to-end
                                                                                       │
                     G3 launch checklist ◄─ WAVE 2 (≈1 week) ◄─────────────────────────┘
                            │
                            ▼
                     3–5 friendly tenants live · WAVE 3 = async unlocks + Phase 2
```

## Wave 0 · Foundations and spikes

| Task | Lane / agent | Parallel? | Output |
|---|---|---|---|
| W0-01 Contracts | `contracts-architect` | blocking for Wave 1 | OpenAPI, event schemas, keys, `packages/shared` |
| W0-02 LiveKit + Telnyx spike | `voice-livekit-builder` + you | yes | One real call: DID → room → agent → tool → hangup; latency numbers; `sip.trunkPhoneNumber` confirmed |
| W0-03 ElevenAgents spike + grant question | `voice-elevenlabs-builder` + you | yes | One real call on A; email to ElevenLabs sales sent; voice A/B recording |
| W0-04 Long-pole accounts (human) | you | yes | Meta business verification, 1145 WhatsApp number, Telegram bot, Google OAuth consent + brand verification, 10DLC ISV brand, Stripe, Telnyx connection, AWS dev/prod accounts |
| W0-05 Repo, CI, CDK bootstrap | `infra-cdk` | yes | CI green on empty packages; `cdk synth` in CI; OIDC deploy role for dev |

**Gate 1** — contracts merged; at least one spike passes; ADR-0002 marked Accepted (engine default confirmed or switched).

## Wave 1 · Parallel build (seven lanes)

| Task | Lane / agent | Owns | Depends on |
|---|---|---|---|
| W1-10 Data, events, realtime infra | `infra-cdk` | `infra/cdk/**` | W0-01 |
| W1-11 Tenant tool API + booking engine | `tool-api-builder` | `services/tool-api/**` | W0-01 |
| W1-12 Channels gateway + router | `channels-builder` | `services/channels/**` | W0-01 |
| W1-13 Onboarding provisioning + identity | `provisioning-builder` | `services/provisioning/**` | W0-01 |
| W1-14 LiveKit frontdesk worker + adapter | `voice-livekit-builder` | `engines/livekit-agent/**`, `engines/livekit-adapter/**` | W0-01, W0-02 |
| W1-15 ElevenAgents adapter (fallback) | `voice-elevenlabs-builder` | `engines/elevenlabs-adapter/**` | W0-01, W0-03 |
| W1-16 Onboarding + admin agents | `agents-builder` | `agents/**`, `evals/**` | W0-01 |
| W1-17 Post-call, usage, live publisher | `postcall-builder` | `services/post-call/**` | W0-01 |

Each lane builds against contracts and mocks; no lane waits for another lane's code. `infra-cdk` wires lanes'
handlers in by path convention (`services/<svc>/src/handlers/*.ts` → one Lambda each), so it can run ahead.

**Integration (2–3 days, orchestrator + `test-engineer`):** merge order contracts → infra → tool-api → the rest;
deploy to dev; run `evals/scenarios/*`.

**Gate 2** — the end-to-end scenario passes in dev:
friend link → WhatsApp → signup → reverse confirmation → provisioning → owner confirms facts → owner names agent →
smoke-test call → a second phone calls the DID and books → dashboard receives `booking.created` live → owner asks
the admin agent "what's booked tomorrow?" and gets the right answer → transcript, summary and usage recorded.

## Wave 2 · Harden and launch

| Task | Lane / agent | Output |
|---|---|---|
| W2-20 Control plane + billing | `control-plane-builder` | Stripe webhook → `setTenantState`, kill switch, usage → Stripe, audit log |
| W2-21 Abuse controls | `tool-api-builder` + `channels-builder` | Card before number activation, per-tenant minute caps, rate limits, spam-call filter |
| W2-22 Eval harness in CI | `test-engineer` | Scenario suite gates every agent-template change |
| W2-23 Observability | `infra-cdk` | Correlation IDs end to end, dashboards, alarms (failed calls, tool p95, webhook 5xx, DLQ depth) |
| W2-24 Frontend integration | you + UI build | Flutter tenant app and React admin console against REST + AppSync Events |
| W2-25 Prod deploy + friendly tenants | you | Prod stack, 3–5 tenants onboarded, daily review of calls for two weeks |

**Gate 3** — launch checklist in `docs/runbooks/launch-checklist.md` all green.

## Wave 3 · Async unlocks and Phase 2
Per-tenant SMS after 10DLC approval · customer WhatsApp via BSP · Google Calendar sync after verification ·
campaigns with consent ledger · owner barge-in UI · number porting · ops agents · Twilio failover.

## Definition of done (every task)
- Tests listed in the brief written first and passing; `make test` green.
- No `tenantId` sourced from model output (reviewer greps for it).
- Errors on the call path degrade to "take a message", never to silence.
- Brief's Status block updated; PR reviewed by `security-reviewer`; CI green.
