# ADR-0001: One voice-engine interface for every engine

**Status:** Proposed · **Date:** 2026-10-02 · **Deciders:** Ola McCartney

## Context
Two engines are on the table (LiveKit on Telnyx; ElevenAgents). About four fifths of the product is engine-agnostic.
Billing suspension, knowledge updates and smoke tests must work on whichever engine a tenant runs.

## Decision
All engine-specific code lives behind `VoiceEngine` (`packages/shared/src/voice-engine.ts`):
`provisionTenantAgent`, `updateTenantAgent`, `syncKnowledge`, `bindNumber`, `unbindNumber`, `setTenantState`,
`placeSmokeTestCall`, `normalizeCallEvent`. Each tenant record stores `engine` and an `EngineAgentRef`.
Tools are always served by the tenant tool API; engines never hold tenant data of record.

## Consequences
- Easier: swapping engines per tenant, A/B voice tests, falling back during an outage.
- Harder: engine-specific features (ElevenAgents built-in evals, LiveKit owner barge-in) need a capability flag.
- Revisit: when one engine serves >90% of tenants for a quarter, consider dropping the other adapter.
