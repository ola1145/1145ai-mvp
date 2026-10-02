"""The customer-facing agent and its tools (owned by issue E5)."""
from __future__ import annotations

import asyncio
import json

from livekit.agents import Agent, RunContext, function_tool

from .fillers import pick_filler
from .prompts import as_data, build_instructions
from .resolver import ResolvedTenant
from .tools_client import ToolsClient
from .voice_config import DEFAULT_TUNING


class FrontDesk(Agent):
    def __init__(self, tenant: ResolvedTenant, tools: ToolsClient, *, message_only: bool = False):
        super().__init__(instructions=build_instructions(tenant.instructions))
        self._t = tenant
        self._tools = tools
        self._message_only = message_only
        self._recent_fillers: list[str] = []

    async def _with_filler(self, context: RunContext, coro):
        """If a tool is slow, say a short varied filler instead of leaving dead air."""
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
