"""Call lifecycle events and transcripts (owned by issue E2)."""
from __future__ import annotations


class CallEvents:
    """Publishes call.started / transcript.partial / call.ended to EventBridge and stores the transcript in S3
    at tenants/<tid>/transcripts/<callId>.json. Every event carries correlationId = call id."""

    def __init__(self, tenant_id: str, call_id: str, room_name: str):
        self.tenant_id, self.call_id, self.room_name = tenant_id, call_id, room_name
        self.turns: list[dict] = []

    async def started(self, caller_masked: str) -> None:
        # TODO(E2): PutEvents call.started
        return None

    async def turn(self, role: str, text: str, at_sec: float) -> None:
        # TODO(E2): append + throttled transcript.partial to the live channel (max 2/s)
        self.turns.append({"role": role, "text": text, "atSec": at_sec})

    async def ended(self, duration_sec: int, end_reason: str) -> None:
        # TODO(E2): upload transcript JSON to S3, then PutEvents call.ended with transcriptKey
        return None
