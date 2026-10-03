#!/usr/bin/env bash
# Copy .env values to GitHub Actions secrets and AWS Secrets Manager without ever printing them.
# Usage: scripts/secrets/push.sh <owner>/<repo> [stage] [--dry-run]
#   Run from the directory that holds .env (or set ENV_FILE). --dry-run prints names only and calls nothing.
#
# Names come from docs/API_KEYS.md, which stays the one list of keys:
#   "Product runtime" table        -> Secrets Manager secret 1145/<stage>/runtime (one JSON blob)
#   "Build and orchestration" table -> GitHub Actions secrets (minus the local-only ones below)
#   any secrets.NAME that a workflow reads -> also a GitHub Actions secret (e.g. the e2e gate's Telnyx key)
# .env is parsed as KEY=VALUE data. It is never sourced, so a stray $(...) in a value cannot run.
set -euo pipefail

DRY=0; POS=()
for a in "$@"; do if [ "$a" = "--dry-run" ]; then DRY=1; else POS+=("$a"); fi; done
REPO="${POS[0]:?usage: push.sh <owner>/<repo> [stage] [--dry-run]}"
STAGE="${POS[1]:-dev}"
[[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || { echo "repo must look like owner/name" >&2; exit 2; }
[[ "$STAGE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "stage must be a plain lowercase word such as dev or prod" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DOC="$ROOT/docs/API_KEYS.md"
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found" >&2; exit 1; }
[ -f "$DOC" ] || { echo "$DOC not found" >&2; exit 1; }

# Keys that stay on this machine: GitHub rejects secret names starting with GITHUB_, and the rest are only used locally.
LOCAL_ONLY=" GH_ADMIN_TOKEN GITHUB_MCP_PAT STRIPE_MCP_TEST_KEY "

# First column of each markdown table row under a "## <heading>" -> backticked UPPER_SNAKE names.
names_in_section() {
  awk -v h="## $1" '
    /^## / { on = (index($0, h) == 1); next }
    on && /^\|/ { split($0, c, "|"); print c[2] }' "$DOC" | grep -o '`[A-Z][A-Z0-9_]*`' | tr -d '`' || true
}

declare -A VAL=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"
    if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
    VAL["$key"]="$v"
  fi
done < "$ENV_FILE"

RUNTIME="$(names_in_section 'Product runtime')"
BUILD="$(names_in_section 'Build and orchestration')"
WORKFLOW_READS="$( (grep -rhoE 'secrets\.[A-Z][A-Z0-9_]+' "$ROOT/.github/workflows" 2>/dev/null || true) | sed 's/^secrets\.//' | sort -u)"
[ -n "$RUNTIME" ] && [ -n "$BUILD" ] || { echo "could not read key names from docs/API_KEYS.md" >&2; exit 1; }

gh_names=""
for k in $BUILD $(grep -Fxf <(echo "$RUNTIME") <(echo "$WORKFLOW_READS") || true); do
  [[ "$LOCAL_ONLY" == *" $k "* ]] && continue
  [[ "$gh_names " == *" $k "* ]] && continue
  gh_names+=" $k"
done

for k in $gh_names; do
  [ -n "${VAL[$k]:-}" ] || continue
  if [ "$DRY" = 0 ]; then printf '%s' "${VAL[$k]}" | gh secret set "$k" --repo "$REPO" >/dev/null; fi
  echo "github: $k"
done

json='{}'; count=0
for k in $RUNTIME; do
  [ -n "${VAL[$k]:-}" ] || continue
  json="$(jq -c --arg k "$k" --arg v "${VAL[$k]}" '. + {($k): $v}' <<<"$json")"
  count=$((count + 1))
done
name="1145/${STAGE}/runtime"

if [ "$DRY" = 1 ]; then
  for k in $(jq -r 'keys[]' <<<"$json"); do echo "  runtime key: $k"; done
  echo "aws: $name would be updated ($count keys), dry run"
  missing=""; for k in $RUNTIME $BUILD; do [ -n "${VAL[$k]:-}" ] || missing+=" $k"; done
  [ -z "$missing" ] || echo "not in $ENV_FILE (fine if not needed yet):$missing"
  exit 0
fi

# The JSON goes through a private temp file so it never shows up in a process listing.
umask 077; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
printf '%s' "$json" > "$tmp"
if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$name" --secret-string "file://$tmp" >/dev/null
else
  aws secretsmanager create-secret --name "$name" --secret-string "file://$tmp" >/dev/null
fi
echo "aws: $name updated ($count keys)"
