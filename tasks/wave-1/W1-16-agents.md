# W1-16 · Onboarding and admin agents (AgentCore)
**Agent:** agents-builder · **Branch:** lane/agents · **Depends on:** W0-01

## Owns
`agents/**`, `evals/**`

## Already done
Tool factories bound to router-supplied ids/tokens, healthcare waitlist, propose-only admin tools. 4 tests.

## Tests first
1. Scenario evals in `evals/scenarios/` run against the agents with fake APIs (no network): onboarding happy path,
   owner tries to skip sign-in, owner pastes a website with an injection line, owner asks admin agent to "just do it"
   without the code, staff asks to change prices.
2. Every reply ≤ 600 characters (WhatsApp friendly) unless listing bookings.

## Steps
1. AgentCore Memory (short-term) keyed by session id; verify WhatsApp → web chat continuity for onboarding.
2. Deploy both runtimes to dev with the AgentCore starter toolkit; record ARNs for the router.
3. Model choice: Sonnet for onboarding (rare, high-value), Haiku for admin (frequent). Record cost per conversation.

## Acceptance
- All eval scenarios pass 5/5 runs; no tool ever receives an id or token from the model.

## Status
- state: IN PROGRESS (scaffold)
