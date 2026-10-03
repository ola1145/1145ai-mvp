# Weekly security sweep

Once a week the Q2 lane (security-auditor subagent or a human) sweeps the code merged since the last sweep against
[`../checklists/security-review.md`](../checklists/security-review.md) and updates
[`threat-model.md`](threat-model.md). The per-PR `claude-review` gate catches most problems; this sweep catches what
slips through it, what only shows up once several lanes' code meets, and findings that have gone stale.

Read-only: the sweep edits only `docs/security/**` and `docs/checklists/**`. Anything to fix goes to the owning lane.

## Procedure

1. **Scope.** `git log --oneline <last-sweep-sha>..origin/main` and `git diff --stat <last-sweep-sha>..origin/main`.
   Note the new head SHA.
2. **Re-check open findings.** For each `open` row in the findings register, look at the file. If a merged PR fixed
   it, set `fixed (#PR)`. If the code moved, update the path.
3. **Mechanical greps** (below). Every hit is either fine (say why in the log) or a new finding.
4. **Read the diff of every merged PR that touched** `services/**/handlers`, `services/**/api`, `services/channels`,
   `services/auth`, `engines/**`, `agents/**`, `infra/cdk/lib/**`, `packages/shared/**`, `.github/**`, `scripts/ci/**`
   against the checklist, one item at a time.
5. **Flows and paths.** If a new route, event, queue, agent tool, external call or channel was added, add it to the
   matching STRIDE table and to the injection-path table if untrusted text can reach a model.
6. **File findings.** New row in the findings register (next `SEC-nn`), with lane, file, fix. Then tell the owning
   lane: a Linear issue or comment on the lane's issue, tagged `[1145:<lane>]`, linking the row. Sensitive details go
   to the owner privately, not into this public repo.
7. **Log it.** Add an entry to the log below and a line to the threat model change log. Bump "Last reviewed".

## Mechanical greps

Run from the repo root. They're cheap tripwires, not proof; read every hit.

```bash
# Tenant id from a body, tool arg or prompt (should only come from ctx / route / token)
rg -n "body\.(tenantId|tenant_id|tid)\b|\b(tenant_id|tenantId)\s*[:=]\s*(payload|args|input|body)" services engines agents
rg -n "def \w+\(.*\b(tenant_id|tenantId|onboarding_id|token)\b" agents engines/livekit-agent/src

# Handlers that touch data without requireTenantContext (internal-resolve-* are expected: IAM routes that ARE the resolver)
for f in services/tool-api/src/handlers/*.ts; do grep -q requireTenantContext "$f" || echo "no requireTenantContext: $f"; done

# Raw DynamoDB clients outside the repo factory / route readers
rg -n "new DynamoDBClient|DynamoDBDocumentClient.from" services --glob '!**/test/**'

# Webhooks: parse before verify
rg -n "JSON.parse" services/channels/src services/control-plane/src engines/*/src

# Non-constant-time secret comparisons
rg -n "(secret|token|signature|verify_token)[^=\n]*\s===?\s" services engines packages

# Unconditioned IAM
rg -n "actions: \['(dynamodb|s3|events|sts):\*'\]|resources: \['\*'\]" infra/cdk/lib

# EventBridge rules without a source filter
rg -n "eventPattern: \{ detailType" infra/cdk/lib

# Untrusted text into prompts
rg -n "system_prompt|instructions=|build_instructions|f\".*\{.*(text|transcript|passage|fact)" agents engines/livekit-agent/src
rg -n "def as_data|as_data\(" agents engines

# Approval-gated integrations (ADR-0005)
rg -in "whatsapp|10dlc|messaging_profile|calendar\.events|googleapis.com/auth/calendar|ses:SendEmail|app-store|play-store" services engines agents infra --glob '!**/whatsapp-webhook.ts'

# Secrets or tenant ids in logs
rg -n "console\.(log|info)\(.*(token|secret|tenantId|tid)|log\.info\(.*(token|tenant)" services engines agents

# Workflows: untrusted interpolation, broad triggers, unpinned actions
rg -n "\$\{\{ *github\.event\.(pull_request\.(title|body)|comment\.body|issue\.(title|body))" .github/workflows
rg -n "allowed_bots|pull_request_target|issue_comment" .github/workflows
rg -n "uses: [^@]+@(main|master|v?[0-9]+)\s*$" .github/workflows
```

## Log

### 2026-10-03 · baseline · `main` @ `d126916`
- First sweep; the whole repo is in scope. Most handlers, steps and senders are still stubs, so STRIDE rows mark the
  controls each lane must build.
- Filed SEC-01 to SEC-35 in [threat-model.md](threat-model.md#7-findings-register). Highest priority:
  SEC-01 and SEC-02 (merge pipeline on a public repo), SEC-04 (data wrapper), SEC-05 (LLM-approved facts),
  SEC-06 (SIP attributes trusted from any participant).
- Checklist: added items for data wrapping, untrusted SIP/participant attributes, deterministic approvals,
  EventBridge sources, SSRF, outbound call destinations, fail-closed role mapping, token TTLs and workflow hygiene.
- Open question for the owner: SEC-27, whether tenant ids are allowed in INFO logs.
- Next sweep: 2026-10-10.
