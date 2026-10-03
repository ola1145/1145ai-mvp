"""
Shared per-invocation plumbing for both AgentCore entrypoints, kept free of Strands/boto imports so it is unit tested
with fakes. Identity (onboardingId, runtime session id, tenant token) comes from the payload and request context the
router built, never from the model.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from common.memory import MemoryFactory
from common.sessions import onboarding_session_id

log = logging.getLogger("agents.runtime")

MAX_TEXT_CHARS = 4000
FALLBACK_REPLY = "Sorry, I hit a snag on my end. Could you send that again?"


@dataclass(frozen=True)
class Turn:
    text: str
    session_id: str | None   # None: no trusted session, so no memory
    actor_id: str | None


def _clip(payload: dict) -> str:
    text = payload.get("text", "")
    return text[:MAX_TEXT_CHARS] if isinstance(text, str) else ""


def onboarding_turn(payload: dict) -> Turn:
    sid = onboarding_session_id(payload["onboardingId"])   # KeyError on a payload the router did not build
    return Turn(text=_clip(payload), session_id=sid, actor_id=sid)


def admin_turn(payload: dict, context: Any) -> Turn:
    # The router sets the runtime session id to admin-<tid>-<channel>-<user>. Using it as the actor id too keeps
    # tenants' events apart. Without it we run stateless rather than share a bucket.
    sid = getattr(context, "session_id", None) or None
    return Turn(text=_clip(payload), session_id=sid, actor_id=sid)


def run_turn(turn: Turn, *, make_agent: Callable[[Any], Callable[[str], Any]], memory_factory: MemoryFactory) -> dict:
    """make_agent(session_manager) returns a callable text -> reply. Never raises: the router needs a reply."""
    try:
        try:
            session_manager = memory_factory(turn) if turn.session_id else None
        except Exception:
            log.exception("memory unavailable; continuing stateless")
            session_manager = None
        return {"reply": str(make_agent(session_manager)(turn.text))}
    except Exception:
        log.exception("agent turn failed")
        return {"reply": FALLBACK_REPLY}
