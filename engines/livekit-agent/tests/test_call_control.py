"""E3: transfers, silence handling and call limits. Everything runs against local fakes; no real calls."""
import asyncio
import random
from types import SimpleNamespace

import pytest

from frontdesk import call_control as cc

BANNED = [
    "inconvenience", "your call is important", "please hold", "as an ai", "understand your frustration",
    "certainly", "happy to assist", "anything else i can help", "transfer your call",
]


# ---------- fakes ----------

class FakeSip:
    def __init__(self, fail: Exception | None = None):
        self.fail, self.transfers, self.created = fail, [], []

    async def transfer_sip_participant(self, req):
        if self.fail:
            raise self.fail
        self.transfers.append(req)

    async def create_sip_participant(self, req):
        if self.fail:
            raise self.fail
        self.created.append(req)
        return SimpleNamespace(participant_identity=req.participant_identity)


class FakeRoom:
    def __init__(self):
        self.deleted = []

    async def delete_room(self, req):
        self.deleted.append(req)


def make_ctx(sip: FakeSip | None = None):
    sip = sip or FakeSip()
    room = FakeRoom()
    return SimpleNamespace(api=SimpleNamespace(sip=sip, room=room), room=SimpleNamespace(name="call-abc")), sip, room


class Said:
    def __init__(self):
        self.lines: list[str] = []

    async def __call__(self, line: str) -> None:
        self.lines.append(line)


def assert_sounds_human(line: str):
    low = line.lower()
    assert len(line.split()) <= 40
    assert not any(b in low for b in BANNED), line
    assert "http" not in low and "\n" not in line


# ---------- cold transfer ----------

async def test_cold_transfer_sends_sip_refer_to_the_owner_number():
    ctx, sip, _ = make_ctx()
    ok = await cc.cold_transfer(ctx, "sip-caller-1", "(214) 555-0123")
    assert ok is True
    (req,) = sip.transfers
    assert req.participant_identity == "sip-caller-1"
    assert req.room_name == "call-abc"
    assert req.transfer_to == "tel:+12145550123"


async def test_cold_transfer_rejects_a_bad_number_without_calling_the_api():
    ctx, sip, _ = make_ctx()
    assert await cc.cold_transfer(ctx, "sip-caller-1", "not a number") is False
    assert sip.transfers == []


async def test_cold_transfer_failure_returns_false_instead_of_raising():
    ctx, _, _ = make_ctx(FakeSip(fail=RuntimeError("486 busy")))
    assert await cc.cold_transfer(ctx, "sip-caller-1", "+12145550123") is False


async def test_cold_transfer_times_out_instead_of_hanging():
    class Slow(FakeSip):
        async def transfer_sip_participant(self, req):
            await asyncio.sleep(5)

    ctx, _, _ = make_ctx(Slow())
    assert await cc.cold_transfer(ctx, "sip-caller-1", "+12145550123", timeout_s=0.01) is False


async def test_handoff_says_a_human_line_then_transfers():
    ctx, sip, _ = make_ctx()
    said = Said()
    res = await cc.hand_off(ctx, "sip-caller-1", "+12145550123", said)
    assert res == "transferred"
    assert len(said.lines) == 1 and len(sip.transfers) == 1
    assert_sounds_human(said.lines[0])


async def test_failed_transfer_falls_back_to_take_a_message():
    ctx, _, _ = make_ctx(FakeSip(fail=RuntimeError("503")))
    said, fell_back = Said(), []

    async def on_fallback():
        fell_back.append(True)

    res = await cc.hand_off(ctx, "sip-caller-1", "+12145550123", said, on_fallback=on_fallback)
    assert res == "take_message"
    assert fell_back == [True]
    assert "message" in said.lines[-1].lower()
    for line in said.lines:
        assert_sounds_human(line)


async def test_missing_owner_number_goes_straight_to_take_a_message():
    ctx, sip, _ = make_ctx()
    said = Said()
    assert await cc.hand_off(ctx, "sip-caller-1", None, said) == "take_message"
    assert sip.transfers == [] and "message" in said.lines[-1].lower()


async def test_handoff_prefers_warm_when_flagged_and_briefed(monkeypatch):
    monkeypatch.setenv("WARM_TRANSFER_ENABLED", "true")
    monkeypatch.setenv("OUTBOUND_SIP_TRUNK_ID", "ST_out")
    ctx, sip, _ = make_ctx()
    res = await cc.hand_off(ctx, "sip-caller-1", "+12145550123", Said(), briefing="Dana wants a quote")
    assert res == "transferred" and len(sip.created) == 1 and sip.transfers == []


# ---------- warm transfer (behind a flag) ----------

async def test_warm_transfer_is_off_by_default(monkeypatch):
    monkeypatch.delenv("WARM_TRANSFER_ENABLED", raising=False)
    ctx, sip, _ = make_ctx()
    assert await cc.warm_transfer(ctx, "+12145550123", "caller wants a quote") is False
    assert sip.created == []


async def test_warm_transfer_dials_the_owner_into_the_room_when_enabled():
    ctx, sip, _ = make_ctx()
    briefed = []

    async def brief(text: str):
        briefed.append(text)

    ok = await cc.warm_transfer(
        ctx, "+12145550123", "Dana wants a quote for Friday", enabled=True, trunk_id="ST_out", brief=brief
    )
    assert ok is True
    (req,) = sip.created
    assert req.sip_trunk_id == "ST_out"
    assert req.sip_call_to == "+12145550123"
    assert req.room_name == "call-abc"
    assert req.wait_until_answered is True
    assert briefed == ["Dana wants a quote for Friday"]


async def test_warm_transfer_needs_an_outbound_trunk(monkeypatch):
    monkeypatch.delenv("OUTBOUND_SIP_TRUNK_ID", raising=False)
    ctx, sip, _ = make_ctx()
    assert await cc.warm_transfer(ctx, "+12145550123", "hi", enabled=True) is False
    assert sip.created == []


async def test_warm_transfer_failure_returns_false():
    ctx, _, _ = make_ctx(FakeSip(fail=RuntimeError("no answer")))
    assert await cc.warm_transfer(ctx, "+12145550123", "hi", enabled=True, trunk_id="ST_out") is False


# ---------- silence + length (pure state machine) ----------

def test_constants_match_the_brief():
    assert cc.SILENCE_PROMPT_SECONDS == 8
    assert cc.SILENCE_HANGUP_SECONDS == 20
    assert cc.MAX_CALL_SECONDS == 15 * 60


def test_one_check_in_at_8s_then_polite_close_at_20s():
    t = cc.SilenceTracker(now=0.0)
    assert t.poll(7.9) is None
    assert t.poll(8.0) == "check_in"
    assert t.poll(9.0) is None            # only once
    assert t.poll(19.9) is None
    assert t.poll(20.0) == "close"


def test_speech_resets_the_silence_clock_and_allows_a_new_check_in():
    t = cc.SilenceTracker(now=0.0)
    assert t.poll(8.0) == "check_in"
    t.activity(10.0)
    assert t.poll(17.9) is None
    assert t.poll(18.0) == "check_in"
    assert t.poll(30.0) == "close"


def test_silence_is_paused_while_someone_is_talking():
    t = cc.SilenceTracker(now=0.0)
    t.set_busy(True, 1.0)                 # agent speaking / thinking
    assert t.poll(60.0) is None
    t.set_busy(False, 60.0)               # silence counts from when the talking stopped
    assert t.poll(67.9) is None
    assert t.poll(68.0) == "check_in"


def test_close_is_decided_once():
    t = cc.SilenceTracker(now=0.0)
    assert t.poll(25.0) == "close"        # even if polled late, skip straight to the close
    assert t.poll(26.0) is None


def test_max_call_length_wraps_up_once():
    t = cc.SilenceTracker(now=0.0)
    t.activity(899.0)
    assert t.poll(899.5) is None
    assert t.poll(900.0) == "max_length"
    assert t.poll(901.0) is None


# ---------- silence lines sound like a person ----------

def test_lines_are_short_human_and_varied():
    for pool in (cc.CHECK_IN_LINES, cc.CLOSE_LINES, cc.MAX_LENGTH_LINES, cc.HANDOFF_LINES, cc.FALLBACK_LINES):
        assert len(pool) >= 3
        for line in pool:
            assert_sounds_human(line)


def test_check_ins_stay_short():
    for line in cc.CHECK_IN_LINES:
        assert len(line.split()) <= 8


def test_pick_line_never_repeats_the_last_two():
    rng = random.Random(3)
    recent: list[str] = []
    for _ in range(100):
        line = cc.pick_line(cc.CHECK_IN_LINES, recent, rng)
        assert line not in recent[-2:]
        recent.append(line)


# ---------- the runner ----------

class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self) -> float:
        return self.t

    async def sleep(self, s: float):
        self.t += s
        await asyncio.sleep(0)


async def test_monitor_checks_in_then_closes_and_hangs_up():
    ctx, _, room = make_ctx()
    said, clock = Said(), Clock()
    ctl = cc.CallControl(ctx, said, clock=clock.now, sleep=clock.sleep, rng=random.Random(1))
    await ctl.run()
    assert len(said.lines) == 2
    assert said.lines[0] in cc.CHECK_IN_LINES
    assert said.lines[1] in cc.CLOSE_LINES
    assert len(room.deleted) == 1 and room.deleted[0].room == "call-abc"
    assert ctl.end_reason == "silence"


async def test_monitor_wraps_up_a_marathon_call():
    ctx, _, room = make_ctx()
    said, clock = Said(), Clock()
    ctl = cc.CallControl(ctx, said, clock=clock.now, sleep=clock.sleep, rng=random.Random(1))

    async def chatty():
        while True:
            await clock.sleep(5)
            ctl.on_user_state("speaking")
            ctl.on_user_state("listening")
            if said.lines:
                return

    await asyncio.gather(ctl.run(), chatty())
    assert said.lines[-1] in cc.MAX_LENGTH_LINES
    assert ctl.end_reason == "max_length"
    assert len(room.deleted) == 1


async def test_monitor_stops_quietly_when_the_call_ends():
    ctx, _, room = make_ctx()
    said, clock = Said(), Clock()
    ctl = cc.CallControl(ctx, said, clock=clock.now, sleep=clock.sleep)
    ctl.stop()
    await ctl.run()
    assert said.lines == [] and room.deleted == []


async def test_say_failure_still_ends_the_call_without_raising():
    ctx, _, room = make_ctx()
    clock = Clock()

    async def broken_say(line):
        raise RuntimeError("tts down")

    ctl = cc.CallControl(ctx, broken_say, clock=clock.now, sleep=clock.sleep, rng=random.Random(1))
    await ctl.run()
    assert len(room.deleted) == 1


def test_state_events_pause_and_resume_silence():
    ctx, _, _ = make_ctx()
    ctl = cc.CallControl(ctx, Said(), clock=lambda: 0.0)
    ctl.on_agent_state("speaking")
    assert ctl.tracker.busy is True
    ctl.on_agent_state("listening")
    assert ctl.tracker.busy is False
    ctl.on_user_state("speaking")
    assert ctl.tracker.busy is True
    ctl.on_user_state("listening")
    assert ctl.tracker.busy is False
    ctl.on_agent_state("thinking")
    assert ctl.tracker.busy is True
