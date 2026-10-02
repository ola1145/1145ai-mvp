# ADR-0005: The MVP depends on no third-party approval

**Status:** Accepted (owner decision, 2026-10-02) · **Supersedes:** ADR-0004

## Context
Per-tenant and platform approvals (Meta business verification and WABA, 10DLC brand/campaign, toll-free verification,
Google sensitive-scope verification, SES production access, App Store / Play review) take days to weeks and are outside
our control. The owner wants nothing on the MVP's critical path that another company must approve.

## Decision
Every MVP channel and integration must be usable the moment we have an account and an API key.

| Need | MVP choice (no approval) | Removed to Phase 2 |
|---|---|---|
| Customer reaches the business | Tenant phone number (Telnyx, bought by API) + web chat widget (LiveKit text) | SMS, WhatsApp, customer Telegram |
| Viral entry | `1145.ai/r/CODE` link, shared person-to-person however the friend likes → web chat, or `t.me/1145_bot?start=CODE` | `wa.me` click-to-chat |
| Owner onboarding + copilot | Web chat after Google sign-in (basic scopes) + shared Telegram bot | WhatsApp |
| Owner notifications | Telegram, email (Resend, DNS-verified domain), web push (VAPID), phone call for urgent handoffs | WhatsApp templates, SMS |
| Customer confirmations | Spoken confirmation; email when the caller gives one | SMS confirmations |
| Calendar | Internal booking engine | Google/Outlook Calendar sync (sensitive scopes) |
| Owner app | Flutter web / PWA | App Store / Play distribution |
| Voice quality | ElevenLabs TTS via API key (B+) | Anything that waits on the grant answer |

**Account-level setup** (one-time, ours, not per tenant) is allowed: Telnyx account verified for purchasing numbers and
outbound calls, Stripe account activation (test mode until then), the instant Bedrock Anthropic use-case form, Resend
DNS records, a Google OAuth client with only `openid email profile`.

## Consequences
- Onboarding completes in minutes with no waiting state.
- Reach in the US is narrower without SMS; the friend's own text message carries the link, so the loop still works.
- The WhatsApp webhook code stays in the repo, disabled (`enableWhatsApp=false`), for Phase 2.
- Any PR that introduces an approval-gated dependency fails review (`docs/checklists/security-review.md`).
