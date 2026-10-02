#!/usr/bin/env bash
# Copy .env values to GitHub Actions secrets and AWS Secrets Manager without printing them.
# Usage: scripts/secrets/push.sh <owner>/<repo> [stage]
set -euo pipefail
REPO="${1:?owner/repo}"; STAGE="${2:-dev}"
[ -f .env ] || { echo ".env not found"; exit 1; }
GH_ONLY="CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY AUTOMERGE_PAT LINEAR_API_KEY DEVIN_API_KEY CURSOR_API_KEY"
RUNTIME="TELNYX_API_KEY TELNYX_CONNECTION_ID TELNYX_SIP_USERNAME TELNYX_SIP_PASSWORD TELNYX_PUBLIC_KEY LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET DEEPGRAM_API_KEY ELEVENLABS_API_KEY ELEVENLABS_WEBHOOK_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RESEND_API_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY TOOL_API_TOKEN_SECRET_CURRENT TOOL_API_TOKEN_SECRET_PREVIOUS ENGINE_SECRET ONBOARDING_SERVICE_TOKEN STEP_UP_SECRET"
set -a; . ./.env; set +a
for k in $GH_ONLY; do [ -n "${!k:-}" ] && printf '%s' "${!k}" | gh secret set "$k" --repo "$REPO" && echo "github: $k"; done
json="{"; sep=""
for k in $RUNTIME; do [ -n "${!k:-}" ] && { json+="$sep\"$k\":$(jq -Rn --arg v "${!k}" '$v')"; sep=","; }; done; json+="}"
name="1145/${STAGE}/runtime"
if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$json" >/dev/null
else
  aws secretsmanager create-secret --name "$name" --secret-string "$json" >/dev/null
fi
echo "aws: $name updated ($(jq 'keys|length' <<<"$json") keys)"
