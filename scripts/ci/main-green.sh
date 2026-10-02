#!/usr/bin/env bash
# Merge freeze: fail when the latest completed CI run on main failed. PRs labelled fix-main are exempt.
set -euo pipefail
if jq -e 'index("fix-main")' <<<"${PR_LABELS:-[]}" >/dev/null; then echo "fix-main PR: exempt"; exit 0; fi
c=$(gh run list --repo "$REPO" --branch main --workflow ci.yml --status completed --limit 1 --json conclusion --jq '.[0].conclusion // "success"')
if [ "$c" = "failure" ]; then echo "main is red: merges are frozen until it is fixed (label a fix PR with fix-main)"; exit 1; fi
echo "main is green ($c)"
