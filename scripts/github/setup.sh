#!/usr/bin/env bash
# Configure the GitHub repo for 50 concurrent agent PRs. Usage: GH_TOKEN=$GH_ADMIN_TOKEN scripts/github/setup.sh <owner>/<repo>
# Rulesets on private repos need GitHub Team or higher. Merge queue needs Enterprise Cloud (CI already supports merge_group).
set -euo pipefail
REPO="${1:?owner/repo}"
gh repo view "$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private --source . --push
gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true -F delete_branch_on_merge=true \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F allow_update_branch=true >/dev/null
jq -c '.[]' .github/labels.json | while read -r l; do
  gh label create "$(jq -r .name <<<"$l")" --repo "$REPO" --color "$(jq -r .color <<<"$l")" --description "$(jq -r .description <<<"$l")" --force >/dev/null
done
existing=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="main-protection") | .id' || true)
if [ -n "$existing" ]; then gh api -X PUT "repos/$REPO/rulesets/$existing" --input .github/rulesets/main.json >/dev/null
else gh api -X POST "repos/$REPO/rulesets" --input .github/rulesets/main.json >/dev/null; fi
OWNER_ID=$(gh api user --jq .id)
gh api -X PUT "repos/$REPO/environments/dev" >/dev/null
gh api -X PUT "repos/$REPO/environments/prod" --input - >/dev/null <<JSON
{ "reviewers": [ { "type": "User", "id": $OWNER_ID } ], "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false } }
JSON
echo "Configured $REPO. Next: scripts/secrets/push.sh $REPO, then scripts/github/verify.sh $REPO"
