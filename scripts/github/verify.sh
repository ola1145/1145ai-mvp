#!/usr/bin/env bash
# Assert the repo settings the parallel workflow depends on. Usage: scripts/github/verify.sh <owner>/<repo>
set -euo pipefail
REPO="${1:?owner/repo}"; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
check "auto-merge" "$(gh api "repos/$REPO" --jq .allow_auto_merge)" "true"
check "delete branch on merge" "$(gh api "repos/$REPO" --jq .delete_branch_on_merge)" "true"
check "squash only" "$(gh api "repos/$REPO" --jq '[.allow_squash_merge,.allow_merge_commit,.allow_rebase_merge]|map(tostring)|join(",")')" "true,false,false"
id=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="main-protection") | .id')
want=$(jq -r '.rules[]|select(.type=="required_status_checks").parameters.required_status_checks[].context' .github/rulesets/main.json | sort | tr '\n' ',')
got=$(gh api "repos/$REPO/rulesets/$id" --jq '.rules[]|select(.type=="required_status_checks").parameters.required_status_checks[].context' | sort | tr '\n' ',')
check "required checks" "$got" "$want"
check "prod environment has reviewers" "$(gh api "repos/$REPO/environments/prod" --jq '[.protection_rules[]?|select(.type=="required_reviewers")]|length>0')" "true"
for s in CLAUDE_CODE_OAUTH_TOKEN AUTOMERGE_PAT; do
  gh secret list --repo "$REPO" --json name --jq '.[].name' | grep -qx "$s" && echo "ok   secret $s" || { echo "FAIL secret $s missing"; fail=1; }
done
exit $fail
