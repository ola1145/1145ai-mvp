#!/usr/bin/env bash
# Derive the claude-review verdict from the reviewer's PR comment instead of a file the model has to write.
# stdin: the PR's issue comments as JSON (one array, or several from `gh api --paginate`).
# env:   START   ISO-8601 time the review step began; older comments are ignored so a stale APPROVE cannot pass a new push
#        AUTHORS space-separated allowed comment authors (default "claude[bot]"); comments by anyone else are ignored
# The reviewer's first line must be `Merge gate: APPROVE` or `Merge gate: BLOCK: <rule> <file>:<line> <fix>`.
# Exit 0 only for APPROVE. No matching comment fails closed.
set -euo pipefail
authors="${AUTHORS:-claude[bot]}"
first=$(jq -s -r --arg start "${START:?START is required}" --arg authors "$authors" '
  add // []
  | map(select(.user.login as $u | ($authors | split(" ") | index($u)) != null and .updated_at >= $start)
        | {t: .updated_at, line: ((.body // "") | split("\n")[0] | sub("^[#>*_ ]+"; "") | sub("[*_ ]+$"; ""))}
        | select(.line | test("^Merge gate: (APPROVE|BLOCK)\\b")))
  | sort_by(.t) | last | .line // ""')
case "$first" in
  "Merge gate: APPROVE"*) echo "claude-review: APPROVE"; exit 0;;
  "Merge gate: BLOCK"*)   echo "claude-review: ${first#Merge gate: }"; exit 1;;
  *) echo "claude-review: no 'Merge gate: APPROVE|BLOCK' comment from ${authors} on this run, so the gate fails closed. Re-run the job."; exit 1;;
esac
