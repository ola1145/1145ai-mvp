# AgentCore deployment (owned by issue A1)

Nothing in CI deploys these runtimes. This is the owner runbook; every AWS-touching command is dry-run unless `--apply`.
All commands run from `agents/` so `common/` ships inside each runtime package.

## What gets deployed
| Runtime | Entrypoint | Model | Memory key | Env |
|---|---|---|---|---|
| onboarding | `onboarding/app.py` | Sonnet 4.5 | `onb-<onboardingId>` (web chat + Telegram share it) | `ONBOARDING_API_URL`, `ONBOARDING_SERVICE_TOKEN`, `AGENTCORE_MEMORY_ID` |
| admin | `admin/app.py` | Haiku 4.5 | router runtime session `admin-<tid>-<channel>-<user>` | `TOOL_API_URL`, `AGENTCORE_MEMORY_ID` |

`MODEL_ID` overrides the model. Without `AGENTCORE_MEMORY_ID` the agents run stateless (local dev).
The admin tenant token and the onboarding id arrive in the payload the router builds; no tool takes an id or token.

## Runbook (dev)
1. Create short-term memory, one per agent (30-day event expiry, no long-term strategies):
   `uv run python -m deploy.plan create-memory --stage dev --apply` and note both memory ids.
2. Create the runtime execution role (see IAM below; ideally from the CDK stack, see
   `contracts/CHANGE_REQUESTS/A1-1.md`).
3. Print the starter-toolkit commands: `uv run python -m deploy.plan plan --stage dev --onboarding-memory-id <id> --admin-memory-id <id>`.
   Run them with the toolkit (`uvx --from bedrock-agentcore-starter-toolkit agentcore ...`); confirm flags with
   `agentcore configure --help` and `agentcore launch --help` first. Replace the `<...>` placeholders; the service token
   comes from Secrets Manager, never the command history.
4. Smoke test each runtime with a fixed 33+ character session id, twice in a row, and check the second reply recalls the first:
   `agentcore invoke '{"onboardingId":"smoke","text":"my shop is Kemi Cuts"}' --session-id onb-smoke-0000000000000000000000000`
5. Publish ARNs for the router:
   `uv run python -m deploy.plan publish-arns --stage dev --onboarding-arn <arn> --admin-arn <arn> --onboarding-memory-id <id> --admin-memory-id <id> --apply`
   Writes `/1145/dev/agentcore/{onboarding,admin}-arn` (and `-memory-id`).

## IAM for the execution role
- `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on the Sonnet and Haiku inference profiles.
- `bedrock-agentcore:CreateEvent`, `ListEvents`, `GetEvent`, `ListSessions`, `RetrieveMemoryRecords` on the two memory ARNs.
- ECR pull, CloudWatch Logs, X-Ray, and the standard AgentCore runtime trust policy.
- `secretsmanager:GetSecretValue` only if the service token is fetched at runtime.

Router side (C1): `bedrock-agentcore:InvokeAgentRuntime` on both runtime ARNs.

## Gotchas
- `runtimeSessionId` must be at least 33 characters; `onb-<ULID>` is 30. See change request A1-1.
- Memory session and actor ids must match `[a-zA-Z0-9][a-zA-Z0-9-_]*` and be 100 characters or fewer;
  `common.sessions.memory_session_id` normalises anything else deterministically.
- If memory is unreachable the turn still answers (stateless) and logs the error.
