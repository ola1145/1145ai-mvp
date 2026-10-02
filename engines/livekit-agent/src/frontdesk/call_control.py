"""Transfers, silence handling and call limits (owned by issue E3)."""
from __future__ import annotations

MAX_CALL_SECONDS = 15 * 60
SILENCE_PROMPT_SECONDS = 8      # "Are you still there?" (said naturally, once)
SILENCE_HANGUP_SECONDS = 20


async def cold_transfer(ctx, participant_identity: str, to_e164: str) -> bool:
    """SIP REFER the caller to the owner's number. TODO(E3): ctx.api.sip.transfer_sip_participant(...)."""
    raise NotImplementedError("E3")


async def warm_transfer(ctx, to_e164: str, briefing: str) -> bool:
    """Dial the owner into the room, brief them, then leave. Behind a flag for MVP. TODO(E3)."""
    raise NotImplementedError("E3")
