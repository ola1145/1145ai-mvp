# Voice specifics

- Turn-taking: LiveKit turn detector + endpointing 0.45–2.5 s; interruptions on; ignore < 0.4 s noises. Tune from E8 data.
- TTS: ElevenLabs Flash, stability ~0.45 (lower = more expressive), small style value, speed 1.0. Pick the voice by ear.
- Fillers: only when a tool exceeds 700 ms; rotate from `fillers.py`; never the same twice in a row.
- Numbers: phone numbers in groups ("two one four, five five five..."), prices as people say them ("thirty-five").
- Times: tool API returns `spoken` ("tomorrow at 3 PM"); say that, never the ISO string.
- Silence: one natural check-in at 8 s ("You still there?"), polite close at 20 s.
- Handoff: "Let me grab someone for you, one sec." Not "Please hold while I transfer your call."
- Mistakes: own them quickly. "Oops, I meant Wednesday, not Thursday."
