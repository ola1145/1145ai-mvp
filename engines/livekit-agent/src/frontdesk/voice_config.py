"""Turn-taking and TTS tuning for natural conversation (owned by issue E4). Pin final values after the E8 spike."""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class VoiceTuning:
    # Silence before deciding the caller finished. Too short = interrupting people; too long = dead air.
    min_endpointing_delay: float = 0.45
    max_endpointing_delay: float = 2.5
    allow_interruptions: bool = True
    min_interruption_duration: float = 0.4    # ignore coughs and "mm-hm"
    preemptive_generation: bool = True         # start the reply while the turn detector is still deciding
    tts_model: str = "eleven_flash_v2_5"
    stability: float = 0.45                    # lower = more expressive, less monotone
    similarity_boost: float = 0.8
    style: float = 0.15
    speed: float = 1.0
    filler_after_ms: int = 700                 # say a short filler if a tool takes longer than this


DEFAULT_TUNING = VoiceTuning()


def session_kwargs(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    """Keyword args for livekit.agents.AgentSession (verify names against the pinned livekit-agents version)."""
    return {
        "allow_interruptions": t.allow_interruptions,
        "min_interruption_duration": t.min_interruption_duration,
        "min_endpointing_delay": t.min_endpointing_delay,
        "max_endpointing_delay": t.max_endpointing_delay,
        "preemptive_generation": t.preemptive_generation,
    }


def tts_voice_settings(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    """Fields for elevenlabs.VoiceSettings(...)."""
    return {"stability": t.stability, "similarity_boost": t.similarity_boost, "style": t.style, "speed": t.speed, "use_speaker_boost": True}


def as_dict(t: VoiceTuning = DEFAULT_TUNING) -> dict:
    return asdict(t)
