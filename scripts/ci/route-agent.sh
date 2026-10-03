#!/usr/bin/env bash
# Who should fix a failing PR? Prints "Devin", "@cursor", "@claude" or nothing.
# Usage: route-agent.sh <pr-author-login> <head-branch>
# The branch prefix wins (agents often push through the owner's account); the author login is the fallback.
# Matching is on the prefix, not a substring, so devin/fix-claude-review never goes to Claude.
set -euo pipefail
author="${1:-}"; branch="${2:-}"
case "$branch" in
  devin/*)  echo "Devin"; exit 0;;
  cursor/*) echo "@cursor"; exit 0;;
  claude/*) echo "@claude"; exit 0;;
esac
case "$author" in
  devin*)           echo "Devin";;
  cursor*)          echo "@cursor";;
  claude*)          echo "@claude";;
  *)                echo "";;
esac
