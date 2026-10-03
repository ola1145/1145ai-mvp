"""
LiveKit Agents worker "frontdesk": one process serves every tenant, on phone and on web chat (owned by issue E5).
Run: uv run python -m frontdesk.worker dev | start | download-files

Tenant identity: phone rooms resolve from the dialed number (sip.trunkPhoneNumber), `chat-` rooms from the widget key
in the room metadata. Both go through the resolver; the call-scoped token it returns lives in ToolsClient only.
"""
from __future__ import annotations

import json
import logging
import os

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import aws, deepgram, elevenlabs, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from . import call_control
from .agent import CallWiring, FrontDesk, Mode, closing_line, entry_line, session_options
from .chat import is_chat_room, widget_key_from_metadata
from .events import CallEvents
from .resolver import Resolver, ResolverError, ResolvedTenant
from .sip import SipCallInfo, mask_caller, sip_info_from_attributes
from .tools_client import ToolsClient
from .voice_config import DEFAULT_TUNING, tts_voice_settings

log = logging.getLogger("frontdesk")
TOOL_API_URL = os.environ.get("TOOL_API_URL", "http://localhost:8787")
LLM_MODEL = os.environ.get("LLM_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0")


def _llm():
    return aws.LLM(model=LLM_MODEL, temperature=0.4)


def build_voice_session(ctx: JobContext, voice_id: str) -> AgentSession:
    return AgentSession(
        stt=deepgram.STT(model="nova-3"),
        llm=_llm(),
        tts=elevenlabs.TTS(voice_id=voice_id, model=DEFAULT_TUNING.tts_model, voice_settings=elevenlabs.VoiceSettings(**tts_voice_settings())),
        vad=ctx.proc.userdata["vad"],
        user_away_timeout=call_control.SILENCE_PROMPT_SECONDS,
        userdata={},
        **session_options(DEFAULT_TUNING, turn_detection=MultilingualModel()),
    )


def build_chat_session() -> AgentSession:
    """Text mode: no STT, TTS or VAD. Messages arrive and leave over the room's text streams."""
    return AgentSession(llm=_llm(), user_away_timeout=None, userdata={})


def chat_room_options(participant_identity: str) -> RoomOptions:
    return RoomOptions(
        audio_input=False, audio_output=False, text_input=True, text_output=True,
        participant_identity=participant_identity,
    )


async def _resolve(ctx: JobContext, mode: Mode, info: SipCallInfo) -> tuple[ResolvedTenant | None, bool]:
    """(tenant, resolver_failed). Unknown number/widget -> (None, False). Outage -> (None, True): say a hiccup line."""
    resolver = Resolver()
    try:
        if mode == "chat":
            key = widget_key_from_metadata(ctx.room.metadata) or ""   # "" -> resolver answers None: unknown widget
            return await resolver.resolve_widget(key, ctx.room.name), False
        return await resolver.resolve(info), False
    except ResolverError:
        log.exception("resolver unavailable")
        return None, True


async def _decline(ctx: JobContext, session: AgentSession, mode: Mode, line: str, **start_kwargs) -> None:
    """Nothing to book against (unknown number or widget, or the resolver is down): say a natural line and end."""
    await session.start(room=ctx.room, agent=Agent(instructions="Say the closing line and stop."), record=False, **start_kwargs)
    await session.say(line, allow_interruptions=False)
    await ctx.delete_room()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    mode: Mode = "chat" if is_chat_room(ctx.room.name) else "voice"
    participant = await ctx.wait_for_participant()
    info = sip_info_from_attributes(dict(participant.attributes)) if mode == "voice" else SipCallInfo(None, None, ctx.room.name)
    call_id = info.call_id or ctx.room.name

    tenant, resolver_failed = await _resolve(ctx, mode, info)

    chat_opts = {"room_options": chat_room_options(participant.identity)} if mode == "chat" else {}
    voice_id = (tenant.voice_id if tenant and tenant.voice_id else "") or os.environ.get("ELEVENLABS_DEFAULT_VOICE_ID", "")
    session = build_chat_session() if mode == "chat" else build_voice_session(ctx, voice_id)

    if tenant is None:
        line = closing_line(mode, "trouble" if resolver_failed else "unassigned")
        log.info(json.dumps({"event": "call.declined", "mode": mode, "resolverFailed": resolver_failed, "callId": call_id}))
        await _decline(ctx, session, mode, line, **chat_opts)
        return

    events = CallEvents(tenant.tenant_id, call_id, ctx.room.name)
    tools = ToolsClient(TOOL_API_URL, tenant.token, call_id)
    message_only = tenant.state != "active"
    wiring = CallWiring(
        events=events, ctx=ctx, session=session, mode=mode, tenant_state=tenant.state,
        participant_identity=participant.identity,
    )
    wiring.attach()
    ctx.add_shutdown_callback(lambda: wiring.on_close("job_shutdown"))

    # record=False: transcripts and audio go to our own S3 via events, not to LiveKit Cloud's observability store.
    await session.start(
        room=ctx.room, agent=FrontDesk(tenant, tools, message_only=message_only, text_mode=mode == "chat"),
        record=False, **chat_opts,
    )
    await session.say(entry_line(mode, tenant), allow_interruptions=False)
    await events.started(caller_masked=mask_caller(info.caller) if mode == "voice" else "web chat")
    log.info(json.dumps({
        "event": "call.started", "mode": mode, "tenant": tenant.tenant_id, "callId": call_id,
        "caller": mask_caller(info.caller), "template": tenant.template_version,
    }))


def prewarm(proc) -> None:
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name="frontdesk"))
