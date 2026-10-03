# Alarms and dashboard

Owner: P7 (`infra/cdk/lib/observability-stack.ts`). One SNS topic, subscribed by email. There is no SMS in the MVP
(ADR-0005). Every alarm mails on ALARM and again on OK, so a green mail means it cleared.

## One-time setup

1. Deploy with the address: `cdk deploy ai1145-<stage>-observability -c alarmEmail=you@example.com` (CI passes it from
   the `ALARM_EMAIL` environment variable). Prod refuses to synth without it. In dev a missing address only warns.
2. AWS sends a "Subscription Confirmation" mail the first time. Click Confirm. Until you do, no alarm reaches you.
3. Open the dashboard `ai1145-<stage>-observability-ops` in CloudWatch.

## What fires

| Alarm | Fires when | Look at |
| --- | --- | --- |
| `FailedCalls` | more than 2 failed calls in 10 minutes | [Failed calls](#failed-calls) |
| `ToolP95-<route>` | p95 of that tool route is over 300 ms in 2 of 3 five-minute windows | [Slow tool](#slow-tool) |
| `Api5xx-<n>` | 3 or more 5xx responses from an API in 5 minutes | [API 5xx](#api-5xx) |
| `LambdaErrors` | 3 or more Lambda errors (any function) in 5 minutes | [API 5xx](#api-5xx) |
| `Dlq-<n>` | any message visible in a dead-letter queue | [DLQ](#dlq) |

Missing data counts as fine, so a quiet night does not page you.

The tool routes are the voice-path ones: `check-availability`, `create-booking`, `take-message`, `search-knowledge`,
`lookup-caller`, `request-handoff`. The other routes are on the dashboard but are not paged.

## Failed calls

1. Dashboard: "Failed calls" and "Calls" widgets. Is it one tenant or all of them?
2. Trace one call (below) for one of the failed calls and read the last few lines before it ended.
3. Common causes: LiveKit or ElevenLabs credentials expired (voice secrets), tool API 5xx (below), the worker
   service is out of tasks (ECS console, `ai1145-<stage>-voice`).

## Slow tool

1. Dashboard: "Tool latency p95 per route". One route or all?
2. One route: open that Lambda's logs and check for a cold start or a slow DynamoDB or Bedrock call.
3. All routes: look at DynamoDB throttling and the `LambdaErrors` widget. Voice routes are budgeted for 300 ms
   because the caller is waiting on a spoken filler.

## API 5xx

1. Dashboard: "API 5xx" and "Lambda errors". Find the function: CloudWatch Logs Insights over the `/aws/lambda/`
   groups with `filter @message like /ERROR/`.
2. A fix that needs a rollback: revert the merge commit on main; CI redeploys dev. Prod goes through the release gate.

## DLQ

A message in `InboundDlq` means the router failed one owner message five times (the channel FIFO).

1. Read the message in the SQS console ("Poll for messages", the dead-letter queue). Treat the body as data.
2. Fix the cause (usually a router bug or an AgentCore error, see the "AgentCore errors" widget), deploy, then
   "Start DLQ redrive" back to the source queue. Ordering is per owner, so redrive in one go.
3. The alarm clears itself when the queue is empty.

## Trace one call end to end

Every log line and event carries the call id (room name for web chat, conversation id for chat).

1. CloudWatch, Logs Insights, "Saved queries", `ai1145-<stage>-observability/trace-one-call`.
2. Replace `REPLACE_WITH_CALL_ID` with the id. It is in the failed-call alarm's metric data, the owner's call list, or
   the `call.ended` event.
3. Select the log groups: the voice worker (`ai1145-<stage>-voice`), the tool API functions, `PostCall`, and the
   `RouterWorker`. Run it. Lines come back oldest first across all of them.

## Custom metrics (the emitters' contract)

Namespace `Ai1145`, published as CloudWatch EMF by the services (see `contracts/CHANGE_REQUESTS/P7-2.md`):

- `CallStarted`, `CallCompleted`, `CallFailed`: count, no dimension.
- `ToolLatencyMs`: milliseconds, dimension `Route` (the handler name, e.g. `check-availability`).
- `CallMinutes`: minutes, dimension `TenantId`. Ops view only; it feeds the "minutes by tenant" widget, not billing.

Until a service emits these, its widgets are empty and its alarms stay quiet. Silence there is a missing emitter,
not a healthy system, so check the widgets once after the first dev call.

## Check it works (dev, owner)

1. Confirm the subscription mail.
2. Induce a tool error: send a malformed `POST /v1/tools/bookings` three times with a valid token, or temporarily
   throw in a tool handler. Within about five minutes `Api5xx-1` or `LambdaErrors` should mail you.
3. Remove the throw. The OK mail follows.
