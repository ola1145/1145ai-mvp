# API keys and credentials

Nothing here needs a third-party approval. Store values in `.env` locally (git-ignored), then
`scripts/secrets/push.sh` copies them to GitHub Actions secrets and AWS Secrets Manager. Agents never see values.

## Product runtime

| Variable | Service | Get it from | Used by |
|---|---|---|---|
| `TELNYX_API_KEY` | Telnyx | Portal → Auth → API Keys | number search/order, call control |
| `TELNYX_CONNECTION_ID` | Telnyx | Created by `scripts/telnyx/setup.ts` (FQDN connection → LiveKit SIP) | provisioning |
| `TELNYX_SIP_USERNAME`, `TELNYX_SIP_PASSWORD` | Telnyx | Credential connection (for LiveKit outbound trunk) | smoke calls, transfers |
| `TELNYX_PUBLIC_KEY` | Telnyx | Portal → Keys & Credentials → Public key | webhook signature check |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud (or Telnyx-hosted LiveKit) | Project settings → Keys | voice worker, token endpoint |
| `DEEPGRAM_API_KEY` | Deepgram | Console → API Keys | STT (Nova-3) |
| `ELEVENLABS_API_KEY` | ElevenLabs | Profile → API Keys | TTS (Flash) |
| `ELEVENLABS_DEFAULT_VOICE_ID` | ElevenLabs | Voice library (not secret) | default voice |
| `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs | Only if the ElevenAgents fallback is enabled | fallback engine |
| `TELEGRAM_BOT_TOKEN` | Telegram | @BotFather `/newbot` (instant) | owner bot |
| `TELEGRAM_WEBHOOK_SECRET` | self-generated | `openssl rand -hex 32` | webhook check |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud | APIs & Services → Credentials → OAuth client (Web). Scopes `openid email profile` only, which need no verification | Cognito sign-in |
| `STRIPE_SECRET_KEY` | Stripe | Developers → API keys (use a restricted key) | billing, card on file |
| `STRIPE_WEBHOOK_SECRET` | Stripe | Developers → Webhooks → endpoint secret | billing webhook |
| `STRIPE_PUBLISHABLE_KEY` | Stripe | Developers → API keys (not secret) | your UI |
| `RESEND_API_KEY` | Resend | API Keys (domain verified by DNS) | owner email |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | self-generated | `npx web-push generate-vapid-keys` | web push |
| `TOOL_API_TOKEN_SECRET_CURRENT`, `TOOL_API_TOKEN_SECRET_PREVIOUS` | self-generated | `openssl rand -base64 48` | service tokens |
| `ENGINE_SECRET`, `ONBOARDING_SERVICE_TOKEN`, `STEP_UP_SECRET` | self-generated | `openssl rand -base64 48` | internal auth |
| (none) | AWS Bedrock | IAM role; one-time instant Anthropic use-case form in the console | LLMs |
| `GEMINI_API_KEY` (optional) | Google AI Studio | You have it | fallback LLM |

## Build and orchestration

| Variable | Service | Get it from | Used by |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude (Max) | `claude setup-token` | GitHub Actions: review, @claude fixes |
| `ANTHROPIC_API_KEY` (optional) | Claude API | console.anthropic.com | Actions if Max limits are hit at 30+ PRs/hour |
| `LINEAR_API_KEY` | Linear | Settings → Security & access → Personal API keys | bootstrap + dispatch scripts |
| `DEVIN_API_KEY` | Devin | Settings → API (Team plan) | dispatch fallback |
| `CURSOR_API_KEY` | Cursor | Dashboard → Integrations → API keys | dispatch fallback (Grok model) |
| `XAI_API_KEY` (optional) | xAI | console.x.ai | only if you call Grok outside Cursor |
| `GH_ADMIN_TOKEN` | GitHub | Fine-grained PAT: Administration, Contents, Secrets, Variables, Environments (this repo) | `scripts/github/setup.sh` |
| `AUTOMERGE_PAT` | GitHub | Fine-grained PAT: Contents + Pull requests write | auto-merge (so merges trigger deploys) |
| `GITHUB_MCP_PAT` | GitHub | Fine-grained PAT, read-only | GitHub MCP in Claude Code/Cursor |
| `STRIPE_MCP_TEST_KEY` | Stripe | Restricted **test-mode** key | Stripe MCP for agents |
| (none) | AWS deploys | OIDC roles from `GithubOidcStack`; repo variables `AWS_DEV_DEPLOY_ROLE_ARN`, `AWS_PROD_DEPLOY_ROLE_ARN` | deploy workflows |

## Account-level checks (one-time, not per tenant)
- Telnyx account verified for buying numbers and outbound calls.
- Stripe account activated before charging real cards (test mode works now).
- GitHub Team (or higher) for rulesets on a private repo; merge queue needs Enterprise Cloud (CI already supports it).
- Devin Team plan for the API; Cursor background agents enabled with the default model set to Grok.
- Flutter: ship web/PWA for the MVP; App Store and Play review are Phase 2.

## Removed from the MVP (Phase 2)
Meta/WhatsApp (business verification, WABA, display name, templates) · SMS (10DLC, toll-free verification) ·
Google Calendar (sensitive-scope verification) · SES production access · app-store review · waiting on the ElevenLabs grant.
