#!/usr/bin/env bash
# Merge freeze: fail when the latest decisive CI run on main failed. PRs labelled fix-main are exempt.
# "Decisive" means success or failure; cancelled runs (a push superseded by a newer one) and skipped runs are ignored.
set -euo pipefail
if jq -e 'index("fix-main")' <<<"${PR_LABELS:-[]}" >/dev/null; then echo "fix-main PR: exempt"; exit 0; fi
runs=$(gh run list --repo "$REPO" --branch main --workflow ci.yml --status completed --limit 20 --json conclusion --jq '.[].conclusion')
latest=$(printf '%s\n' "$runs" | grep -m1 -E '^(success|failure)$' || true)
if [ "$latest" = "failure" ]; then
  echo "main is red, so merges are frozen. Fix main first, or label your fix PR fix-main to merge it anyway."
  exit 1
fi
echo "main is green"
