"""Turn-taking and TTS tuning for natural conversation (owned by issue E4).

Status of the numbers (read before changing any of them)
-------------------------------------------------------
Endpointing, interruption and filler timing are meant to come from E8's real-call measurements
(docs/runbooks/spike-livekit-telnyx-call.md, results in tasks/wave-0/W0-02-spike-livekit.md). E8 hasn't recorded
anything yet, so every one of those values is PROVISIONAL: a starting point from the conversation-style guide and
LiveKit's defaults, with the measurement and decision rule that will replace it written next to it in
TUNING_PROVENANCE. When E8 lands, update the value, flip its status to "measured" and cite the record in `source`
and the numbers in `evidence`. tests/test_naturalness.py fails if a value has no provenance.

TTS voice and stability are picked by ear with the owner: 3 library voices x AB_STABILITY on AB_CALL_SCRIPTS
(ab_trials). That listening test needs real ElevenLabs synthesis, so it is not run from here.

Wiring (worker.py, owned by E5): pass `turn_handling=turn_handling(MultilingualModel())` to AgentSession. Note that
when `turn_handling=` is given, AgentSession silently ignores the legacy flat kwargs, including `turn_detection=`,
so the detector has to go inside it. `session_kwargs()` keeps the legacy shape until that switch happens.
"""
from __future__ import annotations

import re
from collections.abc import AsyncIterable, Callable, Sequence
from dataclasses import asdict, dataclass, replace
from typing import Any, Literal

# Spike record E8 writes to; cited by every "measured" value.
E8_RECORD = "tasks/wave-0/W0-02-spike-livekit.md"


@dataclass(frozen=True)
class VoiceTuning:
    # Silence before deciding the caller finished. Too short = interrupting people; too long = dead air.
    min_endpointing_delay: float = 0.45
    max_endpointing_delay: float = 2.5
    allow_interruptions: bool = True
    min_interruption_duration: float = 0.4     # ignore coughs and "mm-hm"
    min_interruption_words: int = 0
    false_interruption_timeout: float = 1.5    # after a cough stops us, resume instead of sitting in silence
    resume_false_interruption: bool = True
    preemptive_generation: bool = True         # start the reply while the turn detector is still deciding
    tts_model: str = "eleven_flash_v2_5"
    stability: float = 0.45                    # lower = more expressive, less monotone
    similarity_boost: float = 0.8
    style: float = 0.0                         # anything above 0 costs ElevenLabs latency
    speed: float = 1.0
    use_speaker_boost: bool = False            # costs latency; the gain is lost on 8 kHz phone audio
    filler_after_ms: int = 700                 # say a short filler if a tool takes longer than this


DEFAULT_TUNING = VoiceTuning()


@dataclass(frozen=True)
class Provenance:
    status: Literal["decided", "provisional", "measured"]
    source: str                 # where the current value came from
    decide_by: str = ""         # provisional: the measurement and rule that will settle it
    evidence: str = ""          # measured: the numbers, e.g. "p50 gap 0.9 s, 0 cut-offs over 24 turns"


_AB = "Owner A/B by ear: 3 voices x AB_STABILITY on AB_CALL_SCRIPTS, then confirmed on two E8 recorded calls."

TUNING_PROVENANCE: dict[str, Provenance] = {
    "min_endpointing_delay": Provenance(
        "provisional", "conversation-style voice.md range 0.45-2.5 s; LiveKit default 0.5 s.",
        "E8: over >= 10 real turns, count callers cut off mid-sentence and the gap from their last word to our first "
        "audio (LiveKit end-of-utterance + TTS TTFB metrics). Any cut-off: +0.1 s. None and p50 gap > 1.2 s: -0.05 s, "
        "floor 0.3 s."),
    "max_endpointing_delay": Provenance(
        "provisional", "conversation-style voice.md range 0.45-2.5 s; LiveKit streaming default 2.5 s.",
        "E8: listen for callers pausing mid-thought (reading a number, checking a calendar). Cut off at the max: raise "
        "toward 3.0 s. Callers waiting on us in silence: lower toward 2.0 s."),
    "allow_interruptions": Provenance("decided", "conversation-style SKILL.md: interruptions allowed on voice."),
    "min_interruption_duration": Provenance(
        "provisional", "conversation-style voice.md: ignore noises under 0.4 s (LiveKit default 0.5 s).",
        "E8: false interruptions per call (coughs, mm-hm, line noise) vs times we talked over a real 'wait'. More than "
        "one false stop per call: +0.1 s. Any talk-over: -0.1 s."),
    "min_interruption_words": Provenance(
        "provisional", "LiveKit default (0): duration alone decides.",
        "E8: if line noise still stops the agent at the chosen duration, require 1 word (costs one STT interim, "
        "roughly 100-200 ms of extra talk-over)."),
    "false_interruption_timeout": Provenance(
        "provisional", "LiveKit default 2.0 s, shortened so a cough doesn't leave two seconds of dead air.",
        "E8: silence after false interruptions. Resumed too eagerly over a caller who was about to talk: back to "
        "2.0 s."),
    "resume_false_interruption": Provenance(
        "decided", "Failure on the call path is never silence: finish the sentence after a cough."),
    "preemptive_generation": Provenance(
        "decided", "1145-voice-livekit latency budget (LLM first token <= 500 ms): overlap the LLM with endpointing."),
    "tts_model": Provenance("decided", "ADR-0002 / 1145-voice-livekit: ElevenLabs Flash for lowest TTFB."),
    "stability": Provenance("provisional", "conversation-style voice.md: ~0.45.", _AB),
    "similarity_boost": Provenance("provisional", "ElevenLabs default range (0.75-0.8).", _AB),
    "style": Provenance(
        "decided", "ElevenLabs voice settings docs: style exaggeration above 0 adds latency; prompt carries tone."),
    "speed": Provenance("provisional", "conversation-style voice.md: 1.0.", _AB),
    "use_speaker_boost": Provenance(
        "provisional", "ElevenLabs voice settings docs: speaker boost adds latency; phone audio is 8 kHz.", _AB),
    "filler_after_ms": Provenance(
        "provisional", "conversation-style voice.md: fillers only when a tool is slower than 700 ms.",
        "E8: per-tool latency p50/p95. Fillers should cover the slow tail, not most lookups: if a tool's p50 sits "
        "just above the threshold, fix the tool first, then move the threshold to roughly its p75."),
}

# Values the brief says must come from E8's real-call measurements.
TURN_TAKING_FIELDS = (
    "min_endpointing_delay", "max_endpointing_delay", "min_interruption_duration", "min_interruption_words",
    "false_interruption_timeout", "filler_after_ms",
)


def provisional_fields() -> list[str]:
    """What E8 / the owner A/B still has to settle."""
    return [name for name, p in TUNING_PROVENANCE.items() if p.status == "provisional"]


def session_kwargs(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    """Legacy flat kwargs for livekit.agents.AgentSession (accepted, with a deprecation warning, by the pinned 1.x).

    Prefer turn_handling(); see the module docstring for why the two must not be mixed.
    """
    return {
        "allow_interruptions": t.allow_interruptions,
        "min_interruption_duration": t.min_interruption_duration,
        "min_interruption_words": t.min_interruption_words,
        "false_interruption_timeout": t.false_interruption_timeout,
        "resume_false_interruption": t.resume_false_interruption,
        "min_endpointing_delay": t.min_endpointing_delay,
        "max_endpointing_delay": t.max_endpointing_delay,
        "preemptive_generation": t.preemptive_generation,
    }


def turn_handling(turn_detection: Any = None, t: VoiceTuning = DEFAULT_TUNING) -> dict:
    """AgentSession(turn_handling=...) for the pinned livekit-agents. Put the turn detector in here, not beside it."""
    th: dict[str, Any] = {
        "endpointing": {"mode": "fixed", "min_delay": t.min_endpointing_delay, "max_delay": t.max_endpointing_delay},
        "interruption": {
            "enabled": t.allow_interruptions,
            "min_duration": t.min_interruption_duration,
            "min_words": t.min_interruption_words,
            "resume_false_interruption": t.resume_false_interruption,
            "false_interruption_timeout": t.false_interruption_timeout,
        },
        "preemptive_generation": {"enabled": t.preemptive_generation},
    }
    if turn_detection is not None:
        th["turn_detection"] = turn_detection
    return th


def tts_voice_settings(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    """Fields for elevenlabs.VoiceSettings(...)."""
    return {"stability": t.stability, "similarity_boost": t.similarity_boost, "style": t.style, "speed": t.speed,
            "use_speaker_boost": t.use_speaker_boost}


def as_dict(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    return asdict(t)


# ── A/B listening test ────────────────────────────────────────────────────────────────────────────────────────────

AB_STABILITY = (0.35, 0.5)   # either side of the current 0.45: more expressive vs steadier


@dataclass(frozen=True)
class VoiceTrial:
    voice_id: str
    stability: float
    label: str


def ab_trials(voice_ids: Sequence[str]) -> list[VoiceTrial]:
    """3 candidate voices (picked from the ElevenLabs library with the owner) x 2 stability settings = 6 trials."""
    ids = [v.strip() for v in voice_ids]
    if len(ids) != 3 or len(set(ids)) != 3 or not all(ids):
        raise ValueError("A/B needs exactly three distinct voice ids")
    return [VoiceTrial(v, s, f"voice{i + 1}-stability{s}") for i, v in enumerate(ids) for s in AB_STABILITY]


def trial_tuning(trial: VoiceTrial, base: VoiceTuning = DEFAULT_TUNING) -> VoiceTuning:
    return replace(base, stability=trial.stability)


@dataclass(frozen=True)
class ScriptedCall:
    name: str
    person: str | None
    agent_lines: tuple[str, ...]   # what the caller hears, in order; the first line is the disclosure


AB_DISCLOSURE = "Hi, this is Ava at Kemi Cuts. I'm the AI receptionist and calls are recorded. What can I do for you?"


def _call(name: str, person: str | None, *lines: str) -> ScriptedCall:
    return ScriptedCall(name, person, (AB_DISCLOSURE, *lines))


# Ten short calls that hit what TTS tends to get wrong: names, prices, times, phone numbers, apologies, questions.
AB_CALL_SCRIPTS: tuple[ScriptedCall, ...] = (
    _call("booking", "Tunde",
          "Sure, tomorrow afternoon works. I've got three or three-thirty. Either of those good?",
          "Got it, Tunde. You're all set for a haircut tomorrow at three.",
          "Perfect, see you then!"),
    _call("price", None,
          "A men's cut is thirty-five dollars, and a beard trim's another ten.",
          "Yep, the cut takes about forty-five minutes. Want me to find you a time?"),
    _call("hours-and-parking", None,
          "We're open Tuesday to Saturday, nine to six. Closed Sundays and Mondays.",
          "There's free parking right out front, and more behind the building.",
          "Nope, no appointment needed for a quick lineup, but Saturdays get busy."),
    _call("reschedule", "Ada",
          "No problem, Ada. What day works better for you?",
          "Thursday's pretty open. I could do ten in the morning or two in the afternoon.",
          "Done. You're moved to Thursday at two. See you then!"),
    _call("upset-caller", "Jordan",
          "Ugh, sorry about that. Let's get it sorted.",
          "I can't see what happened from here, but I'll get a message to Kemi right now so she can call you back.",
          "What's the best number to reach you?",
          "Got it, two one four, five five five, zero one two three. She'll call you back this afternoon."),
    _call("handoff", None,
          "Sure, let me grab someone for you, one sec.",
          "Looks like everyone's with a client right now. Want me to take a message so they can call you back?",
          "Okay, and what's it about?",
          "Got it. I'll pass that on and someone will call you back soon."),
    _call("are-you-a-robot", None,
          "I am, yeah. I'm the AI receptionist here, but I can still book you in or pass a message along.",
          "Let me see what's open Friday.",
          "Friday at eleven or one, which one's better?"),
    _call("misheard", None,
          "Sorry, I missed that. What day was it?",
          "Got it, Thursday at four. Should I put you down?",
          "Oops, my mistake. Wednesday at four, then. Want me to book it?",
          "You're all set for Wednesday at four. See you then!"),
    _call("fully-booked", None,
          "Saturday's fully booked, unfortunately. I could do Friday at five or next Tuesday at ten.",
          "No worries. Want me to take a message for Kemi in case something opens up?",
          "Done, she'll get it today. Take care!"),
    _call("slow-lookup", None,
          "One sec, let me look.",
          "Okay, I've got Friday at eleven with Kemi. Should I grab it?",
          "You're booked for Friday at eleven. Anything else?",
          "Alright, have a good one!"),
)


# ── Pronunciation: business, staff and service names (ElevenLabs alias rules) ───────────────────────────────────────

@dataclass(frozen=True)
class Pronunciation:
    text: str     # as written, e.g. "Kemi Cuts"
    say_as: str   # spelled the way it sounds, e.g. "Keh-mee Cuts"


def _clean(prons: Sequence[Pronunciation]) -> list[Pronunciation]:
    """Validated, de-duplicated (case-insensitive, first wins), longest first so "Kemi Cuts" beats "Kemi"."""
    seen: dict[str, Pronunciation] = {}
    for p in prons:
        text, say = " ".join(p.text.split()), " ".join(p.say_as.split())
        if not text or not say:
            raise ValueError("a pronunciation needs both the written text and how to say it")
        seen.setdefault(text.lower(), Pronunciation(text, say))
    return sorted(seen.values(), key=lambda p: -len(p.text))


def elevenlabs_alias_rules(prons: Sequence[Pronunciation]) -> list[dict]:
    """Rules for ElevenLabs POST /v1/pronunciation-dictionaries/add-from-rules. Alias rules work on every model,
    including Flash (phoneme rules don't)."""
    return [{"type": "alias", "string_to_replace": p.text, "alias": p.say_as} for p in _clean(prons)]


def pronunciation_dictionary_request(business_name: str, prons: Sequence[Pronunciation]) -> dict:
    """Body for creating a tenant's dictionary. Provisioning makes the call and stores (id, version_id)."""
    return {"name": f"{business_name.strip()} names"[:100], "rules": elevenlabs_alias_rules(prons)}


def pronunciation_locators(dictionary_id: str | None, version_id: str | None) -> list:
    """elevenlabs.TTS(pronunciation_dictionary_locators=...) for a stored dictionary; [] when there is none."""
    if not dictionary_id or not version_id:
        return []
    from livekit.plugins.elevenlabs import PronunciationDictionaryLocator
    return [PronunciationDictionaryLocator(pronunciation_dictionary_id=dictionary_id, version_id=version_id)]


def _is_word_char(c: str) -> bool:
    return bool(c) and (c.isalnum() or c == "_")


def alias_transform(prons: Sequence[Pronunciation]) -> Callable[[AsyncIterable[str]], AsyncIterable[str]]:
    """A streaming TTS text transform that swaps names for their say_as spelling before synthesis.

    Works today with no ElevenLabs dictionary provisioned. Whole words only, case-insensitive, and safe when the LLM
    streams a name split across chunks: text that could still turn into a name is held back until it can't.
    """
    rules = _clean(prons)
    lookup = {p.text.lower(): p.say_as for p in rules}
    keys = list(lookup)
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(p.text) for p in rules) + r")(?!\w)", re.I) if rules else None
    longest = max((len(k) for k in keys), default=0)

    def apply(region: str, prev: str) -> str:
        assert pattern is not None
        out: list[str] = []
        last = pos = 0
        while (m := pattern.search(region, pos)):
            if m.start() == 0 and _is_word_char(prev):   # glued to text we already sent: not a whole word
                pos = 1
                continue
            out += [region[last:m.start()], lookup[" ".join(m.group(0).split()).lower()]]
            last = pos = m.end()
        out.append(region[last:])
        return "".join(out)

    def held_from(buf: str, prev: str) -> int:
        """Earliest word start whose tail could still become a name; len(buf) if none."""
        for p in range(max(0, len(buf) - longest), len(buf)):
            before = buf[p - 1] if p else prev
            if _is_word_char(buf[p]) and not _is_word_char(before):
                tail = buf[p:].lower()
                if any(k.startswith(tail) for k in keys):
                    return p
        return len(buf)

    async def transform(text: AsyncIterable[str]) -> AsyncIterable[str]:
        if pattern is None:
            async for chunk in text:
                yield chunk
            return
        buf, prev = "", ""
        async for chunk in text:
            buf += chunk
            cut = held_from(buf, prev)
            if cut:
                ready, buf = buf[:cut], buf[cut:]
                yield apply(ready, prev)
                prev = ready[-1]
        if buf:
            yield apply(buf, prev)

    return transform


def tts_text_transforms(prons: Sequence[Pronunciation]) -> list:
    """AgentSession(tts_text_transforms=...). Setting it replaces LiveKit's defaults, so keep both built-in filters."""
    base: list = ["filter_markdown", "filter_emoji"]
    return base + [alias_transform(prons)] if prons else base
