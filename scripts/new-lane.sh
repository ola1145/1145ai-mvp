#!/usr/bin/env bash
# Create a git worktree for one lane. Usage: scripts/new-lane.sh <lane> <brief-path>
set -euo pipefail
LANE="${1:?lane name}"; BRIEF="${2:?brief path}"
WT="../1145-wt/${LANE}"
if git show-ref --quiet "refs/heads/lane/${LANE}"; then
  git worktree add "${WT}" "lane/${LANE}"
else
  git worktree add -b "lane/${LANE}" "${WT}" main
fi
(cd "${WT}" && pnpm install --frozen-lockfile >/dev/null)
echo "Worktree ready: ${WT}"
echo "Next: cd ${WT} && claude    then: Read CLAUDE.md and ${BRIEF}, start with the tests."
