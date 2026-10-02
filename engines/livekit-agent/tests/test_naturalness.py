import random

from frontdesk.fillers import FILLERS, pick_filler
from frontdesk.prompts import build_instructions
from frontdesk.voice_config import DEFAULT_TUNING, session_kwargs, tts_voice_settings

BANNED = ["inconvenience", "your call is important", "please hold", "as an ai", "understand your frustration"]


def test_fillers_never_repeat_the_last_two():
    rng = random.Random(7)
    recent: list[str] = []
    for _ in range(200):
        f = pick_filler(recent, rng)
        assert f not in recent[-2:]
        recent.append(f)


def test_fillers_are_short_and_human():
    for f in FILLERS:
        assert len(f.split()) <= 6
        assert not any(b in f.lower() for b in BANNED)


def test_style_and_guardrails_reach_the_model():
    text = build_instructions("You are Ava at Kemi Cuts.")
    assert "contractions" in text and "<data>" in text


def test_tuning_is_expressive_and_interruptible():
    assert session_kwargs()["allow_interruptions"] is True
    assert tts_voice_settings()["stability"] < 0.6
    assert DEFAULT_TUNING.filler_after_ms <= 800
