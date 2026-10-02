"""Customer web chat on the same agent in text mode (owned by issue E5)."""
from __future__ import annotations

CHAT_ROOM_PREFIX = "chat-"


def is_chat_room(room_name: str) -> bool:
    return room_name.startswith(CHAT_ROOM_PREFIX)
