"""
LiveKit Agents worker "frontdesk": one process serves every tenant.
Run: uv run python -m frontdesk.worker dev | start | download-files
Verify plugin argument names against the pinned livekit-agents version during W0-02.
"""
from __future__ import annotations

import json
import logging
import os

from livekit import api
from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli, function_tool
from livekit.plugins import aws, deepgram, elevenlabs, silero

from .prompts import as_data, build_instructions
from .resolver import ResolvedTenant, Resolver
from .sip import sip_info_from_attributes
from .tools_client import ToolsClient

log = logging.getLogger("frontdesk")
TOOL_API_URL = os.environ.get("TOOL_API_URL", "http://localhost:8787")
LLM_MODEL = os.environ.get("LLM_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
UNASSIGNED = "Sorry, this number isn't set up yet. Please try again later."
PAUSED = "Thanks for calling. We can't book right now, but I can take a message for the team."


class FrontDesk(Agent):
    def __init__(self, tenant: ResolvedTenant, tools: ToolsClient, *, message_only: bool = False):
        super().__init__(instructions=build_instructions(tenant.instructions))
        self._t = tenant
        self._tools = tools
        self._message_only = message_only

    @function_tool()
    async def check_availability(self, context: RunContext, date_from: str, date_to: str, service_id: str | None = None) -> str:
        """Find open appointment times. date_from and date_to are ISO 8601 date-times; keep the range within 7 days."""
        if self._message_only:
            return "Booking is unavailable right now. Offer to take a message."
        r = await self._tools.check_availability(date_from, date_to, service_id)
        if "sayToCaller" in r and "slots" not in r:
            return r["sayToCaller"]
        slots = r.get("slots", [])
        if not slots:
            return "No openings in that range. Offer the next day or take a message."
        return as_data(json.dumps([{"start": s["start"], "spoken": s["spoken"]} for s in slots]))

    @function_tool()
    async def book_appointment(self, context: RunContext, slot_start: str, service_id: str, customer_name: str, email: str | None = None) -> str:
        """Book a slot returned by check_availability. Confirm the time and the caller's name before calling this."""
        if self._message_only:
            return "Booking is unavailable right now. Offer to take a message."
        r = await self._tools.create_booking(slot_start, service_id, customer_name, email)
        return r.get("sayToCaller", "Booked.")

    @function_tool()
    async def take_message(self, context: RunContext, from_name: str, message: str, urgent: bool = False) -> str:
        """Record a message for the team when you cannot help directly or the caller asks for a callback."""
        return (await self._tools.take_message(from_name, message, urgent)).get("sayToCaller", "Message taken.")

    @function_tool()
    async def lookup_business_info(self, context: RunContext, question: str) -> str:
        """Look up owner-confirmed facts about the business (services, prices, policies, location, parking)."""
        r = await self._tools.search_knowledge(question)
        passages = [p["text"] for p in r.get("passages", [])]
        return as_data("\n---\n".join(passages)) if passages else "No confirmed answer. Offer to take a message."

    @function_tool()
    async def transfer_to_team(self, context: RunContext, reason: str) -> str:
        """Connect the caller to a person at the business, or take a message if nobody is available."""
        r = await self._tools.request_handoff(reason)
        if r.get("action") == "transfer" and r.get("transferTo"):
            # TODO(W1-14): warm transfer = dial the owner into this room via CreateSIPParticipant, brief them, then leave.
            # Cold transfer (MVP): SIP REFER of the caller to the owner's number.
            context.userdata["transfer_to"] = r["transferTo"]
        return r.get("sayToCaller", "One moment.")


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    info = sip_info_from_attributes(dict(participant.attributes))
    tenant = await Resolver().resolve(info)

    session = AgentSession(
        stt=deepgram.STT(model="nova-3"),
        llm=aws.LLM(model=LLM_MODEL, temperature=0.3),
        tts=elevenlabs.TTS(voice_id=(tenant.voice_id if tenant and tenant.voice_id else os.environ.get("DEFAULT_VOICE_ID", "")), model="eleven_flash_v2_5"),
        vad=ctx.proc.userdata["vad"],
        userdata={},
    )

    if tenant is None:
        await session.start(room=ctx.room, agent=Agent(instructions="Say the closing line and end the call."))
        await session.say(UNASSIGNED, allow_interruptions=False)
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        return

    tools = ToolsClient(TOOL_API_URL, tenant.token, info.call_id or ctx.room.name)
    message_only = tenant.state != "active"
    await session.start(room=ctx.room, agent=FrontDesk(tenant, tools, message_only=message_only))
    await session.say(PAUSED if message_only else tenant.disclosure_line, allow_interruptions=False)
    log.info(json.dumps({"event": "call.started", "tenant": tenant.tenant_id, "callId": info.call_id, "room": ctx.room.name, "template": tenant.template_version}))
    # TODO(W1-14): publish call.started; stream transcript.partial to the live channel; on shutdown write the transcript
    # to S3 (tenants/<tid>/transcripts/<callId>.json) and publish call.ended via ctx.add_shutdown_callback.


def prewarm(proc) -> None:
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name="frontdesk"))
