#!/usr/bin/env bash
# Headless, ralph-style loop for one brief. Usage: scripts/run-lane.sh <brief-path> [max-iterations]
# Stops when the brief's Status says "state: DONE" AND make test passes. Permissions come from .claude/settings.json.
set -euo pipefail
BRIEF="${1:?brief path}"; MAX="${2:-10}"
mkdir -p .lane-logs
LOG=".lane-logs/$(basename "${BRIEF}" .md).log"
for i in $(seq 1 "${MAX}"); do
  echo "=== ${BRIEF} · iteration ${i}/${MAX} ===" | tee -a "${LOG}"
  claude -p "Read CLAUDE.md and ${BRIEF}. Continue from the brief's Status block using the working loop. \
When every Acceptance item is met and make test passes, set 'state: DONE' in the Status block and stop." \
    --permission-mode acceptEdits | tee -a "${LOG}"
  if grep -q "state: DONE" "${BRIEF}" && make test >/dev/null 2>&1; then
    echo "DONE after ${i} iteration(s)" | tee -a "${LOG}"; exit 0
  fi
done
echo "Stopped after ${MAX} iterations without DONE; read ${LOG}" ; exit 2
