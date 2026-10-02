"""
LiveKit Agents worker "frontdesk": one process serves every tenant (owned by issue E5).
Run: uv run python -m frontdesk.worker dev | start | download-files
"""
from __future__ import annotations

import json
import logging
import os

from livekit import api
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import aws, deepgram, elevenlabs, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from .agent import FrontDesk
from .events import CallEvents
from .resolver import Resolver
from .sip import sip_info_from_attributes
from .tools_client import ToolsClient
from .voice_config import DEFAULT_TUNING, session_kwargs, tts_voice_settings

log = logging.getLogger("frontdesk")
TOOL_API_URL = os.environ.get("TOOL_API_URL", "http://localhost:8787")
LLM_MODEL = os.environ.get("LLM_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
UNASSIGNED = "Sorry, this number isn't set up yet. Please try again a little later."
PAUSED = "Thanks for calling! We can't book right now, but I'd be glad to take a message for the team."


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    info = sip_info_from_attributes(dict(participant.attributes))
    # TODO(E5): web chat rooms resolve by widget key from room metadata instead of the dialed number (see chat.py).
    tenant = await Resolver().resolve(info)

    voice_id = tenant.voice_id if tenant and tenant.voice_id else os.environ.get("ELEVENLABS_DEFAULT_VOICE_ID", "")
    session = AgentSession(
        stt=deepgram.STT(model="nova-3"),
        llm=aws.LLM(model=LLM_MODEL, temperature=0.4),
        tts=elevenlabs.TTS(voice_id=voice_id, model=DEFAULT_TUNING.tts_model, voice_settings=elevenlabs.VoiceSettings(**tts_voice_settings())),
        vad=ctx.proc.userdata["vad"],
        turn_detection=MultilingualModel(),
        userdata={},
        **session_kwargs(),
    )

    if tenant is None:
        await session.start(room=ctx.room, agent=Agent(instructions="Say the closing line and end the call."))
        await session.say(UNASSIGNED, allow_interruptions=False)
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        return

    events = CallEvents(tenant.tenant_id, info.call_id or ctx.room.name, ctx.room.name)
    tools = ToolsClient(TOOL_API_URL, tenant.token, info.call_id or ctx.room.name)
    message_only = tenant.state != "active"
    await session.start(room=ctx.room, agent=FrontDesk(tenant, tools, message_only=message_only))
    await session.say(PAUSED if message_only else tenant.disclosure_line, allow_interruptions=False)
    await events.started(caller_masked="")
    log.info(json.dumps({"event": "call.started", "tenant": tenant.tenant_id, "callId": info.call_id, "template": tenant.template_version}))
    # TODO(E2/E3): wire session transcript events -> events.turn; shutdown -> events.ended; transfer_to -> call_control.


def prewarm(proc) -> None:
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name="frontdesk"))
