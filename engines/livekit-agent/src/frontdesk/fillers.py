"""Short, varied things a person says while looking something up (owned by issue E4).

Fillers play only when a tool is slow (voice_config.filler_after_ms). They are spoken outside the chat context, so the
prompt tells the model to lead with the answer afterwards instead of announcing the lookup a second time.
"""
from __future__ import annotations

import random
import re
from collections.abc import Sequence

# Fits any lookup. Nothing here may mention times or openings: it also plays while checking parking or prices.
FILLERS = (
    "One sec, let me look.",
    "Let me check that.",
    "Okay, give me a second.",
    "Hang on a sec.",
    "Hmm, let me see.",
    "Bear with me one sec.",
)

# Extra lines that only make sense for one kind of lookup. pick_filler mixes them with FILLERS.
FILLERS_BY_KIND: dict[str, tuple[str, ...]] = {
    "availability": (
        "Let me see what's open.",
        "Checking what we've got.",
        "Okay, pulling up the schedule.",
    ),
    "booking": (
        "Okay, putting you in now.",
        "Getting you booked, one sec.",
        "Locking that in.",
    ),
    "info": (
        "Let me double-check that.",
        "I'll find out, one sec.",
        "Ah, let me make sure.",
    ),
}

ACKS = ("Got it.", "Sure.", "Okay.", "Perfect.", "Sounds good.", "Alright.")


def _first_word(s: str) -> str:
    w = s.split()
    return re.sub(r"[^\w']", "", w[0].lower()) if w else ""


def pick(
    options: Sequence[str],
    recent: list[str],
    rng: random.Random | None = None,
    *,
    last_agent_turn: str | None = None,
) -> str:
    """Never repeat any of the last two picks, and avoid starting the way the last thing we said started.

    Constraints relax in order (opener first, then the two-back rule) only if a pool is too small to satisfy them;
    an immediate repeat of the last pick is avoided whenever more than one option exists.
    """
    r = rng or random
    opts = list(dict.fromkeys(options))
    avoid_openers = {_first_word(x) for x in (recent[-1:] + ([last_agent_turn] if last_agent_turn else []))}
    for candidates in (
        [o for o in opts if o not in recent[-2:] and _first_word(o) not in avoid_openers],
        [o for o in opts if o not in recent[-2:]],
        [o for o in opts if o not in recent[-1:]],
    ):
        if candidates:
            return r.choice(candidates)
    return r.choice(opts)


def pick_filler(
    recent: list[str],
    rng: random.Random | None = None,
    *,
    kind: str = "any",
    last_agent_turn: str | None = None,
) -> str:
    """kind: "availability", "booking", "info" or "any" (unknown kinds get the generic lines)."""
    return pick(FILLERS + FILLERS_BY_KIND.get(kind, ()), recent, rng, last_agent_turn=last_agent_turn)


def pick_ack(recent: list[str], rng: random.Random | None = None) -> str:
    return pick(ACKS, recent, rng)
