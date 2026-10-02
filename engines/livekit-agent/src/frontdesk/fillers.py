"""Short, varied things a person says while looking something up (owned by issue E4)."""
from __future__ import annotations

import random

FILLERS = (
    "One sec, let me look.",
    "Let me check that.",
    "Okay, checking now.",
    "Bear with me a second.",
    "Let me see what's open.",
    "Just a moment.",
)

ACKS = ("Got it.", "Sure.", "Okay.", "Perfect.", "Sounds good.", "Alright.")


def pick(options: tuple[str, ...], recent: list[str], rng: random.Random | None = None) -> str:
    """Never repeat any of the last two picks."""
    r = rng or random
    fresh = [o for o in options if o not in recent[-2:]]
    return r.choice(fresh or list(options))


def pick_filler(recent: list[str], rng: random.Random | None = None) -> str:
    return pick(FILLERS, recent, rng)


def pick_ack(recent: list[str], rng: random.Random | None = None) -> str:
    return pick(ACKS, recent, rng)
