"""E5: worker integration and customer web chat (text mode). No network, no LiveKit server, no paid APIs."""
from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import re
import tomllib
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from frontdesk import agent as agent_mod
from frontdesk import chat
from frontdesk.agent import (
    CHAT_GREETING_FALLBACK,
    PAUSED_CHAT,
    PAUSED_VOICE,
    STILL_THERE,
    TIME_LIMIT,
    TRANSFER_FAILED,
    TROUBLE_CHAT,
    TROUBLE_VOICE,
    UNASSIGNED_CHAT,
    UNASSIGNED_VOICE,
    CallWiring,
    FrontDesk,
    closing_line,
    entry_line,
    session_options,
)
from frontdesk.resolver import Resolver, ResolverError, ResolvedTenant
from frontdesk.sip import SipCallInfo
from frontdesk.tools_client import ToolsClient
from frontdesk.voice_config import DEFAULT_TUNING

WIDGET_KEY = "wk_" + "a1B2c3D4e5F6g7H8"

BANNED = [
    "inconvenience", "your call is important", "please hold", "as an ai", "understand your frustration",
    "thank you for your patience", "kindly", "assist you", "is there anything else",
]


def make_tenant(state: str = "active", **kw) -> ResolvedTenant:
    base = dict(
        tenant_id="t_1", token="SECRET-TOKEN", state=state, agent_name="Ava", business_name="Kemi Cuts",
        timezone="America/Chicago", disclosure_line="Hi, this is Ava at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?",
        instructions="You are Ava at Kemi Cuts.", voice_id=None, language="en-US", template_version="v1",
    )
    base.update(kw)
    return ResolvedTenant(**base)


def resolved_payload(state: str = "active") -> dict:
    return {
        "tenantId": "t_1", "token": "SECRET-TOKEN", "state": state,
        "agent": {
            "agentName": "Ava", "businessName": "Kemi Cuts", "timezone": "America/Chicago",
            "disclosureLine": "Hi, this is Ava at Kemi Cuts.", "instructions": "You are Ava.", "templateVersion": "v1",
        },
    }


class FakeTools:
    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.calls: list[tuple] = []

    async def check_availability(self, date_from, date_to, service_id):
        self.calls.append(("availability", date_from, date_to, service_id))
        await asyncio.sleep(self.delay)
        return {"slots": [{"start": "2026-10-06T20:00:00.000Z", "spoken": "Tuesday at three"}]}

    async def create_booking(self, slot_start, service_id, customer_name, email):
        self.calls.append(("booking", slot_start, service_id, customer_name))
        await asyncio.sleep(self.delay)
        return {"sayToCaller": "You're all set for Tuesday at three."}

    async def take_message(self, from_name, body, urgent):
        self.calls.append(("message", from_name, body, urgent))
        return {"sayToCaller": "Got it, I'll pass that along."}

    async def search_knowledge(self, query):
        return {"passages": []}

    async def request_handoff(self, reason):
        return {"action": "transfer", "transferTo": "+12145550123", "sayToCaller": "One sec, connecting you."}


class FakeSession:
    def __init__(self):
        self.said: list[str] = []
        self.closed = False
        self.userdata: dict = {}

    def say(self, text, **kw):
        self.said.append(text)
        fut = asyncio.get_event_loop().create_future()
        fut.set_result(None)
        return fut

    async def aclose(self):
        self.closed = True


def run_ctx(session: FakeSession) -> SimpleNamespace:
    return SimpleNamespace(session=session, userdata=session.userdata)


# ---------------------------------------------------------------- chat rooms resolve via widget key

def test_chat_rooms_are_recognised_by_prefix():
    assert chat.is_chat_room("chat-t_1-0f3a")
    assert not chat.is_chat_room("call-_+19725550100_x")


def test_widget_key_comes_from_room_metadata_only_when_well_formed():
    assert chat.widget_key_from_metadata(json.dumps({"widgetKey": WIDGET_KEY})) == WIDGET_KEY
    assert chat.widget_key_from_metadata(json.dumps({"widgetKey": "nope"})) is None
    assert chat.widget_key_from_metadata("not json") is None
    assert chat.widget_key_from_metadata("") is None
    assert chat.widget_key_from_metadata(None) is None
    assert chat.widget_key_from_metadata(json.dumps(["wk_aaaaaaaaaaaaaaaa"])) is None


def test_tenant_id_in_room_metadata_or_room_name_is_ignored():
    meta = json.dumps({"tenantId": "t_evil", "widgetKey": WIDGET_KEY})
    assert chat.widget_key_from_metadata(meta) == WIDGET_KEY
    assert not hasattr(chat, "tenant_from_room")


async def test_resolver_resolves_chat_by_widget_key_with_no_tenant_in_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=resolved_payload())

    r = Resolver(base_url="https://resolver.test", mode="remote", transport=httpx.MockTransport(handler), signer=lambda *a: {})
    tenant = await r.resolve_widget(WIDGET_KEY, "chat-t_1-abc")
    assert tenant is not None and tenant.tenant_id == "t_1"
    assert seen["url"] == "https://resolver.test/internal/resolve/widget"
    assert seen["body"] == {"widgetKey": WIDGET_KEY, "callId": "chat-t_1-abc"}


async def test_resolver_unknown_widget_and_unassigned_number_are_none():
    r = Resolver(base_url="https://resolver.test", mode="remote", transport=httpx.MockTransport(lambda req: httpx.Response(404)), signer=lambda *a: {})
    assert await r.resolve_widget(WIDGET_KEY, "chat-x") is None
    assert await r.resolve(SipCallInfo(dialed="+19725550100", caller=None, call_id="c1")) is None


async def test_resolver_outage_raises_resolver_error_so_the_worker_can_degrade():
    def boom(request):
        raise httpx.ConnectTimeout("slow")

    r = Resolver(base_url="https://resolver.test", mode="remote", transport=httpx.MockTransport(boom), signer=lambda *a: {})
    with pytest.raises(ResolverError):
        await r.resolve_widget(WIDGET_KEY, "chat-x")
    with pytest.raises(ResolverError):
        await r.resolve(SipCallInfo(dialed="+19725550100", caller=None, call_id="c1"))
    r5 = Resolver(base_url="https://resolver.test", mode="remote", transport=httpx.MockTransport(lambda req: httpx.Response(503)), signer=lambda *a: {})
    with pytest.raises(ResolverError):
        await r5.resolve_widget(WIDGET_KEY, "chat-x")


async def test_resolver_without_a_widget_key_or_dialed_number_never_calls_out():
    def boom(request):
        raise AssertionError("must not call the resolver")

    r = Resolver(base_url="https://resolver.test", mode="remote", transport=httpx.MockTransport(boom), signer=lambda *a: {})
    assert await r.resolve_widget("", "chat-x") is None
    assert await r.resolve(SipCallInfo(dialed=None, caller="+12145550123", call_id="c1")) is None


def test_the_token_never_appears_in_repr_or_in_what_the_model_can_see():
    t = make_tenant()
    assert "SECRET-TOKEN" not in repr(t)
    tools = ToolsClient("https://tools.test", "SECRET-TOKEN", "call1")
    assert "SECRET-TOKEN" not in repr(tools)
    fd = FrontDesk(t, tools)
    assert "SECRET-TOKEN" not in fd.instructions
    for name in ("check_availability", "book_appointment", "take_message", "lookup_business_info", "transfer_to_team"):
        params = set(inspect.signature(getattr(agent_mod.FrontDesk, name)).parameters)
        assert not params & {"tenant_id", "tenantId", "token", "tenant", "call_id"}


# ---------------------------------------------------------------- text mode is chat-style

async def test_text_mode_never_speaks_a_filler_even_when_the_tool_is_slow(monkeypatch):
    monkeypatch.setattr(agent_mod, "DEFAULT_TUNING", dataclasses.replace(DEFAULT_TUNING, filler_after_ms=5))
    session = FakeSession()
    fd = FrontDesk(make_tenant(), FakeTools(delay=0.05), text_mode=True)
    out = await fd.check_availability(run_ctx(session), "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z")
    assert "Tuesday at three" in out
    assert session.said == []


async def test_voice_mode_still_fills_a_slow_tool_with_a_short_filler(monkeypatch):
    monkeypatch.setattr(agent_mod, "DEFAULT_TUNING", dataclasses.replace(DEFAULT_TUNING, filler_after_ms=5))
    session = FakeSession()
    fd = FrontDesk(make_tenant(), FakeTools(delay=0.05))
    await fd.check_availability(run_ctx(session), "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z")
    assert len(session.said) == 1 and len(session.said[0].split()) <= 6


def test_text_mode_instructions_are_chat_style_and_keep_the_guardrails():
    voice = FrontDesk(make_tenant(), FakeTools()).instructions
    text = FrontDesk(make_tenant(), FakeTools(), text_mode=True).instructions
    assert "<data>" in text and "Hard rules" in text
    assert "typing" in text.lower() and "texting" in text.lower()
    assert "typing" not in voice.lower()
    # the voice-only pacing advice must not tell a chat agent to talk
    assert "chat" in text.lower()


def test_chat_instructions_carry_no_secrets_and_name_the_business_only_via_tenant_text():
    text = FrontDesk(make_tenant(), FakeTools(), text_mode=True).instructions
    assert "SECRET-TOKEN" not in text and "t_1" not in text


async def test_text_mode_booking_and_message_tools_still_work():
    tools = FakeTools()
    fd = FrontDesk(make_tenant(), tools, text_mode=True)
    ctx = run_ctx(FakeSession())
    assert "all set" in await fd.book_appointment(ctx, "2026-10-06T20:00:00.000Z", "cut", "Tunde")
    assert "pass that along" in await fd.take_message(ctx, "Tunde", "call me", False)
    assert [c[0] for c in tools.calls] == ["booking", "message"]


async def test_message_only_mode_refuses_booking_but_still_takes_messages():
    tools = FakeTools()
    fd = FrontDesk(make_tenant("suspended"), tools, message_only=True)
    ctx = run_ctx(FakeSession())
    assert "message" in (await fd.book_appointment(ctx, "s", "cut", "T")).lower()
    assert "message" in (await fd.check_availability(ctx, "a", "b")).lower()
    await fd.take_message(ctx, "Tunde", "call me", True)
    assert tools.calls == [("message", "Tunde", "call me", True)]


async def test_transfer_tool_only_records_the_request_for_call_control():
    fd = FrontDesk(make_tenant(), FakeTools())
    session = FakeSession()
    out = await fd.transfer_to_team(run_ctx(session), "wants a person")
    assert session.userdata["transfer_to"] == "+12145550123" and "connecting" in out


# ---------------------------------------------------------------- natural lines for the unhappy paths

ALL_LINES = [
    UNASSIGNED_VOICE, UNASSIGNED_CHAT, PAUSED_VOICE, PAUSED_CHAT, TROUBLE_VOICE, TROUBLE_CHAT,
    STILL_THERE, TIME_LIMIT, TRANSFER_FAILED, CHAT_GREETING_FALLBACK,
]


@pytest.mark.parametrize("line", ALL_LINES)
def test_every_customer_line_sounds_like_a_person(line):
    low = line.lower()
    assert not any(b in low for b in BANNED)
    assert len(line.split()) <= 40
    assert not re.search(r"https?://|\n|^\s*[-*#]", line)
    assert line.count("?") <= 1


def test_chat_lines_do_not_talk_like_a_phone_call():
    for line in (UNASSIGNED_CHAT, PAUSED_CHAT, TROUBLE_CHAT, CHAT_GREETING_FALLBACK):
        assert not re.search(r"\b(calling|hang up|hold on the line|recorded)\b", line.lower())


def test_entry_line_covers_unassigned_suspended_and_over_cap_in_both_modes():
    assert entry_line("voice", None) == UNASSIGNED_VOICE
    assert entry_line("chat", None) == UNASSIGNED_CHAT
    for state in ("suspended", "over_cap"):
        assert entry_line("voice", make_tenant(state)) == PAUSED_VOICE
        assert entry_line("chat", make_tenant(state)) == PAUSED_CHAT


def test_entry_line_for_an_active_tenant_is_the_disclosure_on_calls_and_a_chat_hello_in_chat():
    t = make_tenant()
    assert entry_line("voice", t) == t.disclosure_line
    greeting = entry_line("chat", t)
    assert "Ava" in greeting and "Kemi Cuts" in greeting
    assert "recorded" not in greeting.lower()          # nobody is on a recorded call in chat
    assert "AI" in greeting                            # disclosure is still required


def test_closing_line_for_a_resolver_outage_is_a_hiccup_not_silence():
    assert closing_line("voice", "trouble") == TROUBLE_VOICE
    assert closing_line("chat", "trouble") == TROUBLE_CHAT


# ---------------------------------------------------------------- session options (argument drift)

def test_session_options_use_current_livekit_arguments_not_deprecated_ones():
    from livekit.agents import AgentSession

    params = set(inspect.signature(AgentSession.__init__).parameters)
    opts = session_options()
    assert set(opts) <= params
    deprecated = {
        "min_endpointing_delay", "max_endpointing_delay", "allow_interruptions", "min_interruption_duration",
        "preemptive_generation", "turn_detection", "false_interruption_timeout",
    }
    assert not set(opts) & deprecated
    th = opts["turn_handling"]
    assert th["endpointing"] == {"min_delay": DEFAULT_TUNING.min_endpointing_delay, "max_delay": DEFAULT_TUNING.max_endpointing_delay}
    assert th["interruption"]["enabled"] is True
    assert th["interruption"]["min_duration"] == DEFAULT_TUNING.min_interruption_duration
    assert th["preemptive_generation"]["enabled"] is DEFAULT_TUNING.preemptive_generation


async def test_session_options_turn_handling_is_accepted_by_the_pinned_library():
    from livekit.agents import AgentSession

    AgentSession(**session_options())


def test_plugin_constructor_arguments_used_by_the_worker_exist_in_the_pinned_plugins():
    from livekit.plugins import aws, deepgram, elevenlabs

    assert {"model", "temperature"} <= set(inspect.signature(aws.LLM.__init__).parameters)
    assert {"model"} <= set(inspect.signature(deepgram.STT.__init__).parameters)
    assert {"voice_id", "model", "voice_settings"} <= set(inspect.signature(elevenlabs.TTS.__init__).parameters)


def test_worker_module_imports_and_chat_rooms_are_text_only():
    from frontdesk import worker

    assert callable(worker.entrypoint) and callable(worker.prewarm)
    opts = worker.chat_room_options("visitor-1")
    assert opts.audio_input is False and opts.audio_output is False
    assert opts.text_input is True and opts.text_output is True
    assert opts.participant_identity == "visitor-1"


def test_livekit_packages_are_pinned_exactly():
    deps = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())["project"]["dependencies"]
    lk = [d for d in deps if d.startswith("livekit")]
    assert lk, "livekit dependencies missing"
    for d in lk:
        assert re.search(r"==\d+\.\d+\.\d+", d), f"{d} must be pinned with =="
    names = " ".join(lk)
    for plugin in ("deepgram", "elevenlabs", "aws", "silero", "turn-detector"):
        assert plugin in names


# ---------------------------------------------------------------- session callbacks -> events + call control

class FakeEvents:
    def __init__(self):
        self.turns: list[tuple] = []
        self.ended_with: list[tuple] = []

    async def turn(self, role, text, at_sec):
        self.turns.append((role, text, at_sec))

    async def ended(self, duration_sec, end_reason):
        self.ended_with.append((duration_sec, end_reason))


class FakeControl:
    MAX_CALL_SECONDS = 3600
    SILENCE_PROMPT_SECONDS = 0.0
    SILENCE_HANGUP_SECONDS = 0.05

    def __init__(self, result: bool | Exception = True):
        self.result = result
        self.cold: list[tuple] = []

    async def cold_transfer(self, ctx, identity, to):
        self.cold.append((identity, to))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    async def warm_transfer(self, ctx, to, briefing):
        raise NotImplementedError


class FakeJob:
    def __init__(self):
        self.deleted = 0

    def delete_room(self, *a, **k):
        self.deleted += 1
        fut = asyncio.get_event_loop().create_future()
        fut.set_result(None)
        return fut


def make_wiring(mode="voice", state="active", control=None, clock=None):
    session = FakeSession()
    events = FakeEvents()
    job = FakeJob()
    w = CallWiring(
        events=events, ctx=job, session=session, mode=mode, tenant_state=state,
        participant_identity="sip_+12145550123", control=control or FakeControl(), clock=clock or (lambda: 100.0),
    )
    return w, session, events, job


async def test_conversation_items_become_agent_and_caller_turns_with_offsets():
    now = {"t": 100.0}
    w, _, events, _ = make_wiring(clock=lambda: now["t"])
    now["t"] = 103.5
    await w.on_item("user", "Hi, can I get a cut tomorrow?")
    await w.on_item("assistant", "Sure, what time works?")
    await w.on_item("user", "   ")          # empty text is dropped
    await w.on_item("system", "ignored")    # not part of the transcript
    assert events.turns == [("caller", "Hi, can I get a cut tomorrow?", 3.5), ("agent", "Sure, what time works?", 3.5)]


@pytest.mark.parametrize(
    "close_reason,state,expected",
    [
        ("participant_disconnected", "active", "caller_hangup"),
        ("user_initiated", "active", "caller_hangup"),
        ("error", "active", "error"),
        ("job_shutdown", "active", "agent_hangup"),
        ("task_completed", "active", "agent_hangup"),
        ("participant_disconnected", "suspended", "suspended"),
        ("participant_disconnected", "over_cap", "over_cap"),
        ("error", "suspended", "error"),
    ],
)
async def test_close_publishes_call_ended_once_with_the_right_reason(close_reason, state, expected):
    now = {"t": 100.0}
    w, _, events, _ = make_wiring(state=state, clock=lambda: now["t"])
    now["t"] = 161.4
    await w.on_close(close_reason)
    await w.on_close(close_reason)   # shutdown callbacks can fire twice
    assert events.ended_with == [(61, expected)]


async def test_transfer_runs_after_the_line_is_spoken_not_before():
    control = FakeControl(True)
    w, session, events, _ = make_wiring(control=control)
    session.userdata["transfer_to"] = "+12145550123"
    await w.on_agent_state("listening", "thinking")
    assert control.cold == []
    await w.on_agent_state("speaking", "listening")
    assert control.cold == [("sip_+12145550123", "+12145550123")]
    assert "transfer_to" not in session.userdata
    await w.on_close("participant_disconnected")
    assert events.ended_with[0][1] == "transfer"


@pytest.mark.parametrize("result", [False, NotImplementedError("E3"), RuntimeError("sip refused")])
async def test_failed_transfer_falls_back_to_taking_a_message(result):
    control = FakeControl(result)
    w, session, events, _ = make_wiring(control=control)
    session.userdata["transfer_to"] = "+12145550123"
    await w.on_agent_state("speaking", "idle")
    assert session.said == [TRANSFER_FAILED]
    await w.on_close("participant_disconnected")
    assert events.ended_with[0][1] == "caller_hangup"


async def test_chat_sessions_never_transfer_or_prompt_for_silence():
    control = FakeControl(True)
    w, session, _, _ = make_wiring(mode="chat", control=control)
    session.userdata["transfer_to"] = "+12145550123"
    await w.on_agent_state("speaking", "listening")
    await w.on_user_state("away")
    await asyncio.sleep(0.1)
    assert control.cold == [] and session.said == []


async def test_silence_gets_one_gentle_check_in_then_a_polite_hangup():
    w, session, events, job = make_wiring(control=FakeControl())
    await w.on_user_state("away")
    await asyncio.sleep(0.2)
    assert session.said[0] == STILL_THERE
    assert len(session.said) == 2
    assert any(w in session.said[1].lower() for w in ("bye", "take care"))
    assert job.deleted == 1
    await w.on_close("job_shutdown")
    assert events.ended_with[0][1] == "agent_hangup"


async def test_a_caller_who_comes_back_cancels_the_hangup():
    control = FakeControl()
    control.SILENCE_HANGUP_SECONDS = 0.2
    w, session, _, job = make_wiring(control=control)
    await w.on_user_state("away")
    await asyncio.sleep(0.02)
    await w.on_user_state("speaking")
    await asyncio.sleep(0.3)
    assert session.said == [STILL_THERE] and job.deleted == 0


async def test_call_time_limit_wraps_up_politely():
    control = FakeControl()
    control.MAX_CALL_SECONDS = 0.03
    w, session, events, job = make_wiring(control=control)
    w.start()
    await asyncio.sleep(0.15)
    assert session.said == [TIME_LIMIT] and job.deleted == 1
    await w.on_close("job_shutdown")
    assert events.ended_with[0][1] == "agent_hangup"
    w.stop()


async def test_a_failing_events_sink_never_breaks_the_call():
    class Broken(FakeEvents):
        async def turn(self, *a):
            raise RuntimeError("eventbridge down")

        async def ended(self, *a):
            raise RuntimeError("s3 down")

    w, *_ = make_wiring()
    w._events = Broken()
    await w.on_item("user", "hello")
    await w.on_close("job_shutdown")
