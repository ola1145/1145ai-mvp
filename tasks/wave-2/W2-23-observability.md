# W2-23 · Observability
**Agent:** infra-cdk · **Owns:** `infra/cdk/lib/observability-stack.ts`

Correlation id (call id / room / conversation id) in every log line and event. CloudWatch dashboard: calls,
failed calls, tool p50/p95 per route, webhook 5xx, FIFO age, DLQ depth, AgentCore errors, minutes by tenant.
Alarms to your phone (SNS → SMS/email): failed calls > 2 in 10 min, tool p95 > 300 ms, DLQ > 0, any 5xx burst.
## Status
- state: TODO
