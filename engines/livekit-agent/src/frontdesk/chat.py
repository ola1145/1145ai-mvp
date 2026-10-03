"""Customer web chat on the same agent in text mode (owned by issue E5).

Chat rooms are named `chat-...`. The tenant comes from the widget key the channels service put in the ROOM METADATA
when it created the room (server-side, from the key the visitor's site embeds), resolved through the resolver.
Nothing in the room name or in anything the visitor types decides the tenant."""
from __future__ import annotations

import json
import re

CHAT_ROOM_PREFIX = "chat-"
WIDGET_KEY = re.compile(r"^wk_[A-Za-z0-9]{16,40}$")

# Appended after the shared voice style for text mode. Replaces the "you are talking out loud" feel with texting.
CHAT_STYLE = """
This is a text chat on the business's website, not a phone call. You are typing, not talking:
- Write like a helpful person texting: one to three short sentences, no headings, no sign-offs.
- One question per message. React to what they said first.
- Plain text only. Lists only for reading back a booking or the hours. Emoji only if they use them first.
- Times can be written the way people say them ("tomorrow at 3pm"). Never paste raw ISO dates or codes.
- Never type filler like "one sec" while you look something up; just answer when you have it.
- Match their register: terse if they're terse, lighter if they are.
"""


def is_chat_room(room_name: str) -> bool:
    return room_name.startswith(CHAT_ROOM_PREFIX)


def widget_key_from_metadata(metadata: str | None) -> str | None:
    """The widget key from the room metadata JSON, or None if it is missing or malformed."""
    if not metadata:
        return None
    try:
        data = json.loads(metadata)
    except ValueError:
        return None
    key = data.get("widgetKey") if isinstance(data, dict) else None
    return key if isinstance(key, str) and WIDGET_KEY.match(key) else None


def chat_instructions(instructions: str) -> str:
    return instructions + "\n" + CHAT_STYLE
