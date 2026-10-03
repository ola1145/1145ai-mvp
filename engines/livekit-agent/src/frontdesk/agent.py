"""The customer-facing agent and its tools (owned by issue E5)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Literal

from livekit.agents import Agent, RunContext, function_tool

from . import call_control
from .chat import CHAT_STYLE
from .fillers import pick_filler
from .prompts import GUARDRAILS, as_data, build_instructions
from .resolver import ResolvedTenant
from .tools_client import ToolsClient
from .voice_config import DEFAULT_TUNING, VoiceTuning

log = logging.getLogger("frontdesk")

Mode = Literal["voice", "chat"]

# Everything a caller or visitor can hear or read from this module. One line each, in plain words (1145-conversation-style).
UNASSIGNED_VOICE = "Sorry, this number isn't set up yet. Please try again a little later."
UNASSIGNED_CHAT = "Sorry, this chat isn't set up yet. Please try again a little later."
PAUSED_VOICE = "Thanks for calling! We can't book right now, but I'd be glad to take a message for the team."
PAUSED_CHAT = "Thanks for stopping by! We can't book here right now, but I'd be glad to take a message for the team."
TROUBLE_VOICE = "Sorry, we're having a hiccup on our end. Could you try again in a few minutes?"
TROUBLE_CHAT = "Sorry, something's off on our end. Could you try again in a few minutes?"
STILL_THERE = "Hey, are you still with me?"
GOODBYE_SILENCE = "Okay, I'll let you go. Take care, bye!"
TIME_LIMIT = "I'm sorry, I have to wrap up here. Please call back if you need anything else. Thanks for calling!"
TRANSFER_FAILED = "I couldn't get anyone on the line just now. Want to leave a message so they can call you back?"
CHAT_GREETING_FALLBACK = "Hi, I'm the AI assistant here. This chat is saved so the team can follow up. What can I help with?"

_CLOSINGS = {
    ("voice", "unassigned"): UNASSIGNED_VOICE,
    ("chat", "unassigned"): UNASSIGNED_CHAT,
    ("voice", "paused"): PAUSED_VOICE,
    ("chat", "paused"): PAUSED_CHAT,
    ("voice", "trouble"): TROUBLE_VOICE,
    ("chat", "trouble"): TROUBLE_CHAT,
}


def closing_line(mode: Mode, kind: Literal["unassigned", "paused", "trouble"]) -> str:
    return _CLOSINGS[(mode, kind)]


def chat_greeting(tenant: ResolvedTenant) -> str:
    if not (tenant.agent_name and tenant.business_name):
        return CHAT_GREETING_FALLBACK
    return (
        f"Hi, this is {tenant.agent_name} at {tenant.business_name}. I'm the AI assistant, "
        "and this chat is saved so the team can follow up. What can I help with?"
    )


def entry_line(mode: Mode, tenant: ResolvedTenant | None) -> str:
    """The first thing the caller or visitor hears or reads."""
    if tenant is None:
        return closing_line(mode, "unassigned")
    if tenant.state != "active":
        return closing_line(mode, "paused")
    return tenant.disclosure_line if mode == "voice" else chat_greeting(tenant)


def session_options(tuning: VoiceTuning = DEFAULT_TUNING, turn_detection: Any = None) -> dict[str, Any]:
    """AgentSession kwargs in the livekit-agents >=1.8 shape (turn_handling), not the deprecated flat arguments."""
    turn_handling: dict[str, Any] = {
        "endpointing": {"min_delay": tuning.min_endpointing_delay, "max_delay": tuning.max_endpointing_delay},
        "interruption": {"enabled": tuning.allow_interruptions, "min_duration": tuning.min_interruption_duration},
        "preemptive_generation": {"enabled": tuning.preemptive_generation},
    }
    if turn_detection is not None:
        turn_handling["turn_detection"] = turn_detection
    return {"turn_handling": turn_handling}


class FrontDesk(Agent):
    def __init__(self, tenant: ResolvedTenant, tools: ToolsClient, *, message_only: bool = False, text_mode: bool = False):
        # Text mode swaps the spoken style for texting; the hard rules stay either way.
        instructions = tenant.instructions.strip() + "\n" + CHAT_STYLE + GUARDRAILS if text_mode else build_instructions(tenant.instructions)
        super().__init__(instructions=instructions)
        self._t = tenant
        self._tools = tools
        self._message_only = message_only
        self._text_mode = text_mode
        self._recent_fillers: list[str] = []

    async def _with_filler(self, context: RunContext, coro):
        """If a tool is slow in a call, say a short varied filler instead of leaving dead air. Chat never speaks one."""
        if self._text_mode:
            return await coro
        task = asyncio.ensure_future(coro)
        try:
            return await asyncio.wait_for(asyncio.shield(task), DEFAULT_TUNING.filler_after_ms / 1000)
        except asyncio.TimeoutError:
            line = pick_filler(self._recent_fillers)
            self._recent_fillers.append(line)
            context.session.say(line, add_to_chat_ctx=False)
            return await task

    @function_tool()
    async def check_availability(self, context: RunContext, date_from: str, date_to: str, service_id: str | None = None) -> str:
        """Find open appointment times. date_from and date_to are ISO 8601 date-times; keep the range within 7 days."""
        if self._message_only:
            return "Booking is unavailable right now. Offer to take a message."
        r = await self._with_filler(context, self._tools.check_availability(date_from, date_to, service_id))
        if "sayToCaller" in r and "slots" not in r:
            return r["sayToCaller"]
        slots = r.get("slots", [])
        if not slots:
            return "No openings in that range. Offer the next day or take a message."
        return as_data(json.dumps([{"start": s["start"], "say_it_like": s["spoken"]} for s in slots]))

    @function_tool()
    async def book_appointment(self, context: RunContext, slot_start: str, service_id: str, customer_name: str, email: str | None = None) -> str:
        """Book a slot returned by check_availability, after the caller agreed to the time and told you their name."""
        if self._message_only:
            return "Booking is unavailable right now. Offer to take a message."
        r = await self._with_filler(context, self._tools.create_booking(slot_start, service_id, customer_name, email))
        return r.get("sayToCaller", "Booked.")

    @function_tool()
    async def take_message(self, context: RunContext, from_name: str, message: str, urgent: bool = False) -> str:
        """Record a message for the team when you cannot help directly or the caller asks for a callback."""
        return (await self._tools.take_message(from_name, message, urgent)).get("sayToCaller", "Message taken.")

    @function_tool()
    async def lookup_business_info(self, context: RunContext, question: str) -> str:
        """Look up owner-confirmed facts about the business (services, prices, policies, location, parking)."""
        r = await self._with_filler(context, self._tools.search_knowledge(question))
        passages = [p["text"] for p in r.get("passages", [])]
        return as_data("\n---\n".join(passages)) if passages else "No confirmed answer. Offer to take a message."

    @function_tool()
    async def transfer_to_team(self, context: RunContext, reason: str) -> str:
        """Connect the caller to a person at the business, or take a message if nobody is available."""
        r = await self._tools.request_handoff(reason)
        if r.get("action") == "transfer" and r.get("transferTo"):
            context.userdata["transfer_to"] = r["transferTo"]   # call_control performs it after this turn is spoken
        return r.get("sayToCaller", "One moment.")


_END_REASONS = {
    "participant_disconnected": "caller_hangup",
    "user_initiated": "caller_hangup",
    "error": "error",
    "job_shutdown": "agent_hangup",
    "task_completed": "agent_hangup",
}


class CallWiring:
    """Connects AgentSession callbacks to the other lanes: transcript turns and call.ended (events, E2), transfers,
    silence and call limits (call_control, E3). Handlers are async and take plain values so they are unit-testable;
    `attach` adapts them to the session's sync callbacks. Nothing here may break the call: every sink is best effort."""

    def __init__(self, *, events, ctx, session, mode: Mode, tenant_state: str, participant_identity: str,
                 control=call_control, clock=time.monotonic):
        self._events, self._ctx, self._session = events, ctx, session
        self._mode, self._state, self._identity = mode, tenant_state, participant_identity
        self._control, self._clock = control, clock
        self._started = clock()
        self._end_reason: str | None = None
        self._closed = False
        self._error_told = False
        self._silence_prompted = False
        self._tasks: set[asyncio.Task] = set()
        self._silence_task: asyncio.Task | None = None
        self._limit_task: asyncio.Task | None = None

    # -- lifecycle ---------------------------------------------------------------------------------------------
    def attach(self) -> None:
        s = self._session
        s.on("conversation_item_added", lambda ev: self._spawn(self._on_item_event(ev)))
        s.on("agent_state_changed", lambda ev: self._spawn(self.on_agent_state(ev.old_state, ev.new_state)))
        s.on("user_state_changed", lambda ev: self._spawn(self.on_user_state(ev.new_state)))
        s.on("error", lambda ev: self._spawn(self.on_error(getattr(ev, "recoverable", True))))
        s.on("close", lambda ev: self._spawn(self.on_close(getattr(ev.reason, "value", str(ev.reason)))))
        self.start()

    def start(self) -> None:
        if self._mode == "voice":
            self._limit_task = self._spawn(self._enforce_call_limit())

    def stop(self) -> None:
        for t in list(self._tasks):
            t.cancel()

    def _spawn(self, coro) -> asyncio.Task:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    # -- transcript --------------------------------------------------------------------------------------------
    async def _on_item_event(self, ev) -> None:
        item = ev.item
        if getattr(item, "type", None) == "message":
            await self.on_item(item.role, item.text_content or "")

    async def on_item(self, role: str, text: str) -> None:
        who = {"user": "caller", "assistant": "agent"}.get(role)
        if not who or not text.strip():
            return
        try:
            await self._events.turn(who, text.strip(), round(self._clock() - self._started, 2))
        except Exception:
            log.warning("transcript turn not recorded", exc_info=True)

    # -- end of call -------------------------------------------------------------------------------------------
    async def on_close(self, close_reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        self.stop()
        reason = self._end_reason or _END_REASONS.get(close_reason, "agent_hangup")
        if reason == "caller_hangup" and self._state in ("suspended", "over_cap"):
            reason = self._state
        try:
            await self._events.ended(int(self._clock() - self._started), reason)
        except Exception:
            log.warning("call.ended not published", exc_info=True)

    async def on_error(self, recoverable: bool) -> None:
        if recoverable or self._error_told or self._closed:
            return
        self._error_told = True
        await self._say(closing_line(self._mode, "trouble"))

    # -- transfers (call_control, E3) --------------------------------------------------------------------------
    async def on_agent_state(self, old: str, new: str) -> None:
        if self._mode != "voice" or old != "speaking" or new not in ("listening", "idle"):
            return
        to = self._session.userdata.pop("transfer_to", None)
        if not to:
            return
        try:
            ok = bool(await self._control.cold_transfer(self._ctx, self._identity, to))
        except Exception:
            log.warning("transfer failed", exc_info=True)
            ok = False
        if ok:
            self._end_reason = "transfer"
        else:
            await self._say(TRANSFER_FAILED)   # fall back to taking a message; never leave the caller hanging

    # -- silence and call limits (call_control, E3) ------------------------------------------------------------
    async def on_user_state(self, new: str) -> None:
        if self._mode != "voice" or self._closed:
            return
        if new == "away":
            if self._silence_prompted:
                return
            self._silence_prompted = True
            await self._say(STILL_THERE)
            wait = max(0.0, self._control.SILENCE_HANGUP_SECONDS - self._control.SILENCE_PROMPT_SECONDS)
            self._silence_task = self._spawn(self._hang_up_after(wait, GOODBYE_SILENCE))
        else:
            self._silence_prompted = False
            if self._silence_task:
                self._silence_task.cancel()
                self._silence_task = None

    async def _hang_up_after(self, delay: float, line: str) -> None:
        await asyncio.sleep(delay)
        await self._hang_up(line)

    async def _enforce_call_limit(self) -> None:
        await asyncio.sleep(self._control.MAX_CALL_SECONDS)
        await self._hang_up(TIME_LIMIT)

    async def _hang_up(self, line: str) -> None:
        if self._closed:
            return
        self._end_reason = self._end_reason or "agent_hangup"
        await self._say(line)
        try:
            await self._ctx.delete_room()
        except Exception:
            log.warning("could not delete room", exc_info=True)
            try:
                await self._session.aclose()
            except Exception:
                log.warning("could not close session", exc_info=True)

    async def _say(self, line: str) -> None:
        try:
            await self._session.say(line, allow_interruptions=False)
        except Exception:
            log.warning("could not speak line", exc_info=True)
