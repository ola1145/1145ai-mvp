# W1-12 · Channels gateway and router
**Agent:** channels-builder · **Branch:** lane/channels · **Depends on:** W0-01

## Owns
`services/channels/**`

## Already done
WhatsApp + Telegram webhook verification and normalization, router with onboarding/admin split and
deterministic CONFIRM-code handling, SQS batch processor. 11 tests.

## Tests first
1. prodDeps: `enqueue` sends to FIFO with MessageGroupId = `${channel}:${channelUserId}` and MessageDeduplicationId = channelMessageId.
2. `lookupIdentity` reads `IDENTITY#<channel>#<id>` only (route role).
3. `startOnboarding` creates ONBOARDING + IDENTITY route with a conditional put (two first messages → one onboarding) and records `referralCode`.
4. Senders: WhatsApp Cloud API text send; Telegram sendMessage; both retry 429/5xx with backoff, never on 4xx.
5. AgentCore invoke: runtimeSessionId = sessionId padded to the minimum length the API requires; 25 s timeout → send "One moment, still working on it" then deliver when done.
6. Referral redirect Lambda `GET /r/{code}`: record click (REFCLICK#), 302 to `wa.me/<1145 number>?text=Hi%201145!%20ref:<code>`.

## Acceptance
- A replayed Meta webhook (same message id) produces exactly one agent invocation (integration test with LocalStack or a fake queue).
- Webhook handlers return in < 1 s (no agent call inline).

## Status
- state: IN PROGRESS (scaffold)
