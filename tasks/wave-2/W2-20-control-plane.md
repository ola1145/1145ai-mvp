# W2-20 · Control plane and billing
**Agent:** control-plane-builder · **Owns:** `services/control-plane/**`

Tests first: Stripe webhook verification (exists) + handler mapping to `setTenantState`; kill switch requires a
reason code and lands in the audit bucket; admin console API (tenant list with state/usage/engine, suspend/resume,
force template version, export/delete tenant data); ops role cannot read transcripts without a support-case reason code.
Acceptance: suspend a tenant in dev → its number plays the paused message within 60 s; audit object is immutable.
## Status
- state: IN PROGRESS (scaffold)
