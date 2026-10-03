"""Call lifecycle events and transcripts (owned by issue E2).

Rules this module keeps:
- Envelopes match contracts/events/events.schema.json; correlationId is always the call id.
- The transcript is in S3 before call.ended is published, so post-call can read `transcriptKey` straight away.
- Nothing here ever blocks the audio path or raises into it: AWS calls run in worker threads, partials are
  best-effort, and failures are logged and degrade (call.ended goes out without a key rather than not at all).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("frontdesk.events")

SOURCE = "1145.voice"
END_REASONS = {"caller_hangup", "agent_hangup", "transfer", "error", "over_cap", "suspended"}
PARTIAL_MIN_INTERVAL_SEC = 0.5  # transcript.partial is throttled to 2 per second
MAX_PARTIALS_IN_FLIGHT = 4
RETRIES = 3  # after the first attempt
BACKOFF_SEC = 0.2
_ROLES = {"agent": "agent", "assistant": "agent", "caller": "caller", "user": "caller"}


def mask_phone(e164: str | None) -> str:
    """Same masking as packages/shared maskPhone: `+12145550123` -> `+1••••••0123`. Idempotent."""
    if not e164:
        return "unknown"
    if "•" in e164:
        return e164
    digits = "".join(c for c in e164 if c.isdigit() or c == "+")
    if len(digits) < 6:
        return "•••"
    return f"{digits[:2]}{'•' * max(0, len(digits) - 6)}{digits[-4:]}"


def transcript_key(tenant_id: str, call_id: str) -> str:
    return f"tenants/{tenant_id}/transcripts/{call_id}.json"


def _aws_client(service: str):
    """Real client, built lazily so tests and import never need credentials. boto3 if present, else botocore."""
    from botocore.config import Config

    cfg = Config(connect_timeout=2, read_timeout=4, retries={"max_attempts": 1})
    try:
        import boto3  # type: ignore[import-not-found]

        return boto3.client(service, config=cfg)
    except ImportError:
        import botocore.session

        return botocore.session.get_session().create_client(service, config=cfg)


class CallEvents:
    """Publishes call.started / transcript.partial / call.ended to EventBridge and stores the transcript in S3
    at tenants/<tid>/transcripts/<callId>.json. Every event carries correlationId = call id."""

    def __init__(
        self,
        tenant_id: str,
        call_id: str,
        room_name: str,
        *,
        engine: str = "livekit-telnyx",
        channel: str = "voice",
        bus_name: str | None = None,
        bucket: str | None = None,
        events_client: Any = None,
        s3_client: Any = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ):
        self.tenant_id, self.call_id, self.room_name = tenant_id, call_id, room_name
        self.engine, self.channel = engine, channel
        self.turns: list[dict] = []
        self._bus = bus_name or os.environ.get("EVENT_BUS_NAME", "1145")
        self._bucket = bucket or os.environ.get("TENANT_BUCKET", "")
        self._events, self._s3 = events_client, s3_client
        self._clock, self._sleep = clock, sleep
        self._last_partial: float | None = None
        self._pending: set[asyncio.Task] = set()
        self._ended = False

    # -- public API -------------------------------------------------------------------------------------------

    async def started(self, caller_masked: str) -> None:
        data = {"callId": self.call_id, "engine": self.engine, "channel": self.channel,
                "callerMasked": mask_phone(caller_masked)}
        self._spawn(self._publish("call.started", data, retries=RETRIES))

    async def turn(self, role: str, text: str, at_sec: float) -> None:
        """Record a turn (always) and emit a transcript.partial (at most 2/s, best effort). Returns immediately."""
        if self._ended:
            return
        turn = {"role": _ROLES.get(role, role), "text": text, "atSec": at_sec}
        self.turns.append(turn)
        now = self._clock()
        if self._last_partial is not None and now - self._last_partial < PARTIAL_MIN_INTERVAL_SEC - 1e-9:
            return
        if len(self._pending) >= MAX_PARTIALS_IN_FLIGHT:
            return  # AWS is slow; drop the partial rather than pile up threads
        self._last_partial = now
        self._spawn(self._publish("transcript.partial", {"callId": self.call_id, **turn}, retries=0))

    async def ended(self, duration_sec: int, end_reason: str) -> None:
        """Upload the transcript, then (and only then) publish call.ended. Never raises."""
        if self._ended:
            return
        self._ended = True
        await self.flush(timeout=1.0)  # let started/partials already in flight land before the end event
        key = await self._upload_transcript()
        data: dict[str, Any] = {
            "callId": self.call_id,
            "durationSec": max(0, int(duration_sec)),
            "endReason": end_reason if end_reason in END_REASONS else "error",
        }
        if key:
            data["transcriptKey"] = key
        await self._publish("call.ended", data, retries=RETRIES)

    async def flush(self, timeout: float | None = None) -> None:
        """Wait for in-flight fire-and-forget publishes (call end, tests). Never raises."""
        pending = [t for t in self._pending if not t.done()]
        if pending:
            await asyncio.wait(pending, timeout=timeout)

    # -- internals --------------------------------------------------------------------------------------------

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    def _envelope(self, detail_type: str, data: dict) -> dict:
        occurred = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"type": detail_type, "version": 1, "tenantId": self.tenant_id, "correlationId": self.call_id,
                "occurredAt": occurred, "data": data}

    async def _publish(self, detail_type: str, data: dict, *, retries: int) -> bool:
        entry = {
            "EventBusName": self._bus,
            "Source": SOURCE,
            "DetailType": detail_type,
            "Detail": json.dumps(self._envelope(detail_type, data), ensure_ascii=False),
        }
        return await self._with_retries(f"PutEvents {detail_type}", lambda: self._put_events(entry), retries)

    def _put_events(self, entry: dict) -> None:
        if self._events is None:
            self._events = _aws_client("events")
        resp = self._events.put_events(Entries=[entry])
        if resp.get("FailedEntryCount"):
            raise RuntimeError(f"PutEvents rejected: {resp.get('Entries')}")

    async def _upload_transcript(self) -> str | None:
        key = transcript_key(self.tenant_id, self.call_id)
        body = json.dumps(
            {"callId": self.call_id, "tenantId": self.tenant_id, "roomName": self.room_name, "turns": self.turns},
            ensure_ascii=False,
        )

        def put() -> None:
            if self._s3 is None:
                self._s3 = _aws_client("s3")
            self._s3.put_object(Bucket=self._bucket, Key=key, Body=body.encode("utf-8"),
                                ContentType="application/json", Tagging="kind=transcript")

        ok = await self._with_retries("S3 transcript upload", put, RETRIES)
        return key if ok else None

    async def _with_retries(self, what: str, fn: Callable[[], None], retries: int) -> bool:
        """Run a blocking boto call in a worker thread so the event loop (and audio) is never held."""
        for attempt in range(retries + 1):
            try:
                await asyncio.to_thread(fn)
                return True
            except Exception as exc:  # noqa: BLE001 - degrade, never raise into the call
                log.warning(json.dumps({"event": "events.aws_error", "what": what, "callId": self.call_id,
                                        "attempt": attempt + 1, "error": type(exc).__name__}))
                if attempt < retries:
                    await self._sleep(BACKOFF_SEC * (2**attempt))
        log.error(json.dumps({"event": "events.gave_up", "what": what, "callId": self.call_id}))
        return False
