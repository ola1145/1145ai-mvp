"""Transfers, silence handling and call limits (owned by issue E3).

Pure pieces (`SilenceTracker`, line pools) are unit-tested without LiveKit. `CallControl` runs the silence/length
watchdog against injected `say`/clock/sleep callables, and the transfer helpers take the worker's job context
(`ctx.api.sip`, `ctx.api.room`, `ctx.room.name`), so tests use local fakes and no real call is ever placed.

Failure on the call path means take a message, never silence: a transfer that can't connect says so in plain words
and hands back to the message flow.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from typing import Awaitable, Callable, Literal

from livekit import api

from .sip import normalize_e164

log = logging.getLogger("frontdesk.call_control")

MAX_CALL_SECONDS = 15 * 60
SILENCE_PROMPT_SECONDS = 8      # "You still there?" (said naturally, once)
SILENCE_HANGUP_SECONDS = 20
POLL_SECONDS = 0.25
TRANSFER_TIMEOUT_SECONDS = 15.0

Say = Callable[[str], Awaitable[None]]
SilenceAction = Literal["check_in", "close", "max_length"]
HandoffResult = Literal["transferred", "take_message"]

# ---- What the caller hears. Short, plain, varied (1145-conversation-style). Never "please hold". ----

CHECK_IN_LINES = (
    "You still there?",
    "Hey, still with me?",
    "Hey, are you still there?",
    "Still there?",
)
CLOSE_LINES = (
    "Sounds like I lost you. Call back anytime, we're here. Bye for now!",
    "I'll let you go for now. Feel free to call back whenever. Take care!",
    "Looks like the line went quiet, so I'll hang up. Call us back anytime. Bye!",
)
MAX_LENGTH_LINES = (
    "I've got to wrap up here, but call back anytime and we'll pick it up. Take care!",
    "We've been at this a while, so I'll let you go. Call back anytime. Bye for now!",
    "I need to end this call, but ring us back anytime and we'll keep going. Take care!",
)
HANDOFF_LINES = (
    "Let me grab someone for you, one sec.",
    "Hang on, I'll get someone for you.",
    "One sec, let me get someone on the line.",
)
FALLBACK_LINES = (
    "Sorry, I couldn't get anyone just now. Can I take a message? They'll call you right back.",
    "Looks like nobody's free at the moment. Want to leave a message? I'll make sure they get it.",
    "Hm, I can't reach anyone right now. Let me take a message and they'll call you back.",
)


def pick_line(pool: tuple[str, ...], recent: list[str], rng: random.Random | None = None) -> str:
    """Pick a line that wasn't one of the last two used from this pool."""
    rng = rng or random
    options = [line for line in pool if line not in recent[-2:]] or list(pool)
    return rng.choice(options)


# ---- Silence + length ----

class SilenceTracker:
    """Pure state machine. Feed it the clock; it says when to check in, close, or wrap up a long call.

    Silence only counts while nobody is talking or thinking (`busy`). A check-in is said once per quiet stretch;
    the 20 s close counts from the last real activity, so the agent's own check-in doesn't restart it.
    """

    def __init__(self, now: float):
        self.started = now
        self.last_activity = now
        self.busy = False
        self.checked_in = False
        self.closed = False
        self.wrapped = False
        self._own_check_in_pending = False

    def activity(self, now: float) -> None:
        """Real activity (the caller spoke, or the agent spoke a normal turn). Restarts the silence clock."""
        self.last_activity = now
        self.checked_in = False
        self._own_check_in_pending = False

    def set_busy(self, busy: bool, now: float) -> None:
        was, self.busy = self.busy, busy
        if was and not busy:
            if self._own_check_in_pending:
                self._own_check_in_pending = False   # our own check-in finished; don't restart the 20 s clock
            else:
                self.last_activity = now
                self.checked_in = False

    def poll(self, now: float) -> SilenceAction | None:
        if self.closed or self.wrapped:
            return None
        if now - self.started >= MAX_CALL_SECONDS:
            self.wrapped = True
            return "max_length"
        if self.busy:
            return None
        quiet = now - self.last_activity
        if quiet >= SILENCE_HANGUP_SECONDS:
            self.closed = True
            return "close"
        if quiet >= SILENCE_PROMPT_SECONDS and not self.checked_in:
            self.checked_in = True
            self._own_check_in_pending = True
            return "check_in"
        return None


class CallControl:
    """Watchdog for one call: natural check-in, polite close, max length. `run()` returns when the call is over."""

    def __init__(
        self,
        ctx,
        say: Say,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: random.Random | None = None,
    ):
        self._ctx, self._say, self._clock, self._sleep = ctx, say, clock, sleep
        self._rng = rng or random.Random()
        self.tracker = SilenceTracker(clock())
        self.end_reason: str | None = None
        self._stopped = False
        self._recent: list[str] = []
        self._task: asyncio.Task | None = None

    # -- session state wiring (livekit-agents `user_state_changed` / `agent_state_changed`) --
    def on_user_state(self, state: str) -> None:
        if state == "speaking":
            self.tracker.activity(self._clock())
        self.tracker.set_busy(state == "speaking", self._clock())

    def on_agent_state(self, state: str) -> None:
        self.tracker.set_busy(state in ("speaking", "thinking"), self._clock())

    def attach(self, session) -> None:
        """Subscribe to an AgentSession and start the watchdog in the background."""
        session.on("user_state_changed", lambda ev: self.on_user_state(ev.new_state))
        session.on("agent_state_changed", lambda ev: self.on_agent_state(ev.new_state))
        self._task = asyncio.ensure_future(self.run())

    def stop(self) -> None:
        self._stopped = True
        if self._task and not self._task.done() and self._task is not asyncio.current_task():
            self._task.cancel()

    async def run(self) -> None:
        while not self._stopped:
            action = self.tracker.poll(self._clock())
            if action == "check_in":
                await self._speak(CHECK_IN_LINES)
            elif action in ("close", "max_length"):
                self.end_reason = "silence" if action == "close" else "max_length"
                await self._speak(CLOSE_LINES if action == "close" else MAX_LENGTH_LINES)
                await self._hang_up()
                return
            await self._sleep(POLL_SECONDS)

    async def _speak(self, pool: tuple[str, ...]) -> None:
        line = pick_line(pool, self._recent, self._rng)
        self._recent.append(line)
        try:
            await self._say(line)
        except Exception:   # a broken TTS must not strand the call; we still end it cleanly
            log.warning("call_control.say_failed")

    async def _hang_up(self) -> None:
        try:
            await self._ctx.api.room.delete_room(api.DeleteRoomRequest(room=self._ctx.room.name))
        except Exception:
            log.warning("call_control.hangup_failed")


# ---- Transfers ----

def _mask(e164: str) -> str:
    return "***" + e164[-4:]


async def cold_transfer(
    ctx, participant_identity: str, to_e164: str | None, *, timeout_s: float = TRANSFER_TIMEOUT_SECONDS
) -> bool:
    """SIP REFER the caller to the owner's number. True when the carrier accepted it, False on any failure."""
    to = normalize_e164(to_e164)
    if not to:
        log.warning("call_control.transfer_bad_number")
        return False
    req = api.TransferSIPParticipantRequest(
        participant_identity=participant_identity,
        room_name=ctx.room.name,
        transfer_to=f"tel:{to}",
        play_dialtone=False,
    )
    try:
        await asyncio.wait_for(ctx.api.sip.transfer_sip_participant(req), timeout_s)
    except Exception as e:   # includes timeouts and Twirp errors; the caller falls back to take-a-message
        log.warning("call_control.transfer_failed to=%s err=%s", _mask(to), type(e).__name__)
        return False
    return True


def warm_transfer_enabled() -> bool:
    return os.environ.get("WARM_TRANSFER_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")


async def warm_transfer(
    ctx,
    to_e164: str | None,
    briefing: str,
    *,
    enabled: bool | None = None,
    trunk_id: str | None = None,
    brief: Callable[[str], Awaitable[None]] | None = None,
    timeout_s: float = 45.0,
) -> bool:
    """Dial the owner into the room, give them the briefing, then the caller's agent can step out.

    Off unless WARM_TRANSFER_ENABLED is set (or enabled=True); returns False when off so the caller uses a cold
    transfer instead. `brief` speaks the briefing to the owner (the worker owns the voice); `briefing` is data from
    the model and never sets the number or the tenant.
    """
    if not (warm_transfer_enabled() if enabled is None else enabled):
        return False
    to = normalize_e164(to_e164)
    trunk = trunk_id or os.environ.get("OUTBOUND_SIP_TRUNK_ID")
    if not to or not trunk:
        log.warning("call_control.warm_transfer_not_configured")
        return False
    req = api.CreateSIPParticipantRequest(
        sip_trunk_id=trunk,
        sip_call_to=to,
        room_name=ctx.room.name,
        participant_identity="owner-handoff",
        participant_name="Owner",
        wait_until_answered=True,
    )
    try:
        await asyncio.wait_for(ctx.api.sip.create_sip_participant(req), timeout_s)
        if brief is not None:
            await brief(briefing)
    except Exception as e:
        log.warning("call_control.warm_transfer_failed to=%s err=%s", _mask(to), type(e).__name__)
        return False
    return True


async def hand_off(
    ctx,
    participant_identity: str,
    to_e164: str | None,
    say: Say,
    *,
    briefing: str | None = None,
    brief: Callable[[str], Awaitable[None]] | None = None,
    on_fallback: Callable[[], Awaitable[None]] | None = None,
    rng: random.Random | None = None,
) -> HandoffResult:
    """Say a human line, transfer (warm if the flag is on and there's a briefing, else cold). On any failure say so
    plainly and fall back to take-a-message (`on_fallback` lets the agent switch to message-only)."""
    rng = rng or random.Random()
    if normalize_e164(to_e164):
        await _safe_say(say, pick_line(HANDOFF_LINES, [], rng))
        if briefing and await warm_transfer(ctx, to_e164, briefing, brief=brief):
            return "transferred"
        if await cold_transfer(ctx, participant_identity, to_e164):
            return "transferred"
    await _safe_say(say, pick_line(FALLBACK_LINES, [], rng))
    if on_fallback is not None:
        try:
            await on_fallback()
        except Exception:
            log.warning("call_control.fallback_hook_failed")
    return "take_message"


async def _safe_say(say: Say, line: str) -> None:
    try:
        await say(line)
    except Exception:
        log.warning("call_control.say_failed")
