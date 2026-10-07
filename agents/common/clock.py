"""
The business clock for the owner copilot (CR A3-1). The router puts the tenant's IANA timezone in the payload; until it
does, the default keeps "tomorrow" right for the common case instead of reading it off the UTC clock.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

DEFAULT_TIMEZONE = "America/Chicago"


def business_clock(payload: dict) -> tuple[ZoneInfo, bool]:
    """(zone, known). `known` is False when the payload had no usable timezone and the default was used."""
    raw = payload.get("timezone") if isinstance(payload, dict) else None
    if isinstance(raw, str) and 0 < len(raw) <= 64:
        try:
            return ZoneInfo(raw), True
        except (KeyError, ValueError, OSError):
            pass
    return ZoneInfo(DEFAULT_TIMEZONE), False


def clock_line(now: datetime, tz: ZoneInfo) -> str:
    """One line of per-invocation context for the system prompt. Built from the clock and a validated zone name only."""
    hour12 = now.hour % 12 or 12
    stamp = f"{now:%A, %B} {now.day}, {now.year}, {hour12}:{now.minute:02d} {'AM' if now.hour < 12 else 'PM'}"
    return f"Right now it's {stamp} at the business ({tz.key}). Today's date for tools is {now:%Y-%m-%d}."
