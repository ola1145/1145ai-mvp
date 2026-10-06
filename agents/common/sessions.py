"""
Session ids. The router builds the runtime session id (services/channels/src/router.ts); these helpers mirror its
format so the agents can derive the same key without trusting anything the model produced.

  onboarding: onb-<onboardingId>                 (same thread for web chat and Telegram)
  admin:      admin-<tid>-<channel>-<channelUserId>

AgentCore Memory ids must match [a-zA-Z0-9][a-zA-Z0-9-_]* and be at most 100 characters, so `memory_session_id`
normalises anything outside that, deterministically.
"""
from __future__ import annotations

import hashlib
import re

SESSION_ID_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9\-_]{0,99}")
_BAD = re.compile(r"[^a-zA-Z0-9\-_]+")
MAX_LEN = 100


def onboarding_session_id(onboarding_id: str) -> str:
    return f"onb-{onboarding_id}"


def admin_session_id(tid: str, channel: str, channel_user_id: str) -> str:
    return f"admin-{tid}-{channel}-{channel_user_id}"


def memory_session_id(raw: str) -> str:
    """Deterministic, valid AgentCore Memory id. Clean ids pass through unchanged."""
    if SESSION_ID_RE.fullmatch(raw):
        return raw
    digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
    cleaned = _BAD.sub("-", raw).strip("-_")[: MAX_LEN - 13] or "s"
    return f"{cleaned}-{digest}"
