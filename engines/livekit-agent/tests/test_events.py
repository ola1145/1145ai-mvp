"""E2: call lifecycle events and transcripts. boto3/botocore clients are replaced with fakes."""
import asyncio
import json
import re
import threading
from pathlib import Path

from frontdesk.events import CallEvents, mask_phone

SCHEMA = json.loads((Path(__file__).parents[3] / "contracts/events/events.schema.json").read_text())
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$")
MASKED = "+1••••••0123"


class Log:
    def __init__(self):
        self.order: list[str] = []


class FakeEventBridge:
    def __init__(self, log: Log, fail_times: int = 0, failed_entries_times: int = 0):
        self.log, self.calls = log, []
        self.fail_times, self.failed_entries_times = fail_times, failed_entries_times

    def put_events(self, Entries):
        self.calls.append(Entries)
        detail_type = Entries[0]["DetailType"]
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("throttled")
        if self.failed_entries_times > 0:
            self.failed_entries_times -= 1
            return {"FailedEntryCount": 1, "Entries": [{"ErrorCode": "InternalFailure"}]}
        self.log.order.append(f"put_events:{detail_type}")
        return {"FailedEntryCount": 0, "Entries": [{"EventId": "e"}]}

    @property
    def details(self):
        return [(e[0]["DetailType"], json.loads(e[0]["Detail"])) for e in self.calls]


class FakeS3:
    def __init__(self, log: Log, fail_times: int = 0, always_fail: bool = False):
        self.log, self.puts = log, []
        self.fail_times, self.always_fail = fail_times, always_fail

    def put_object(self, **kw):
        if self.always_fail or self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("s3 down")
        self.puts.append(kw)
        self.log.order.append("s3.put_object")
        return {}


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


async def no_sleep(_):
    return None


def make(**kw):
    log = kw.pop("log", None) or Log()
    eb = kw.pop("eb", None) or FakeEventBridge(log)
    s3 = kw.pop("s3", None) or FakeS3(log)
    clock = Clock()
    ev = CallEvents("t_acme", "call-123", "room-abc", events_client=eb, s3_client=s3, bus_name="1145",
                    bucket="tenant-bucket", clock=clock, sleep=no_sleep, **kw)
    return ev, eb, s3, clock, log


async def drain(ev: CallEvents):
    await asyncio.sleep(0)
    await ev.flush()


def validate_envelope(detail: dict, detail_type: str):
    for k in SCHEMA["required"]:
        assert k in detail, k
    assert detail["type"] == detail_type
    assert detail["version"] == 1
    assert ISO.match(detail["occurredAt"]), detail["occurredAt"]
    assert isinstance(detail["data"], dict)


def validate_data(detail_type: str, data: dict):
    d = SCHEMA["$defs"][detail_type]
    for k in d["required"]:
        assert k in data, k
    for k, spec in d["properties"].items():
        if k not in data:
            continue
        if "enum" in spec:
            assert data[k] in spec["enum"], k
        elif spec.get("type") == "integer":
            assert isinstance(data[k], int) and not isinstance(data[k], bool), k
        elif spec.get("type") == "string":
            assert isinstance(data[k], str), k


async def test_call_started_envelope_matches_contract():
    ev, eb, *_ = make()
    await ev.started("+12145550123")
    await drain(ev)
    ((dt, detail),) = eb.details
    assert dt == "call.started"
    validate_envelope(detail, "call.started")
    validate_data("call.started", detail["data"])
    assert detail["tenantId"] == "t_acme"
    assert detail["correlationId"] == "call-123"  # correlationId = call id
    assert detail["data"] == {"callId": "call-123", "engine": "livekit-telnyx", "channel": "voice", "callerMasked": MASKED}
    entry = eb.calls[0][0]
    assert entry["EventBusName"] == "1145" and entry["Source"] == "1145.voice"


async def test_started_never_publishes_a_raw_number_and_handles_blank():
    ev, eb, *_ = make()
    await ev.started("+12145550123")
    await ev.started("")
    await drain(ev)
    assert "2145550" not in json.dumps(eb.details[0][1])
    assert eb.details[1][1]["data"]["callerMasked"] == "unknown"


async def test_webchat_channel_is_carried():
    ev, eb, *_ = make(channel="webchat")
    await ev.started("visitor")
    await drain(ev)
    assert eb.details[0][1]["data"]["channel"] == "webchat"


async def test_call_ended_envelope_matches_contract_and_has_transcript_key():
    ev, eb, *_ = make()
    await ev.turn("agent", "Thanks for calling, how can I help?", 0.5)
    await ev.ended(42, "caller_hangup")
    ended = [d for t, d in eb.details if t == "call.ended"]
    assert len(ended) == 1
    validate_envelope(ended[0], "call.ended")
    validate_data("call.ended", ended[0]["data"])
    assert ended[0]["correlationId"] == "call-123"
    assert ended[0]["data"]["callId"] == "call-123"
    assert ended[0]["data"]["durationSec"] == 42
    assert ended[0]["data"]["endReason"] == "caller_hangup"
    assert ended[0]["data"]["transcriptKey"] == "tenants/t_acme/transcripts/call-123.json"


async def test_transcript_is_uploaded_before_call_ended_is_published():
    ev, eb, s3, _, log = make()
    await ev.turn("caller", "Hi, can I book a haircut?", 1.0)
    await ev.turn("agent", "Sure, what day works?", 2.0)
    await ev.ended(30, "agent_hangup")
    assert log.order.index("s3.put_object") < log.order.index("put_events:call.ended")
    (put,) = s3.puts
    assert put["Bucket"] == "tenant-bucket"
    assert put["Key"] == "tenants/t_acme/transcripts/call-123.json"
    assert put["ContentType"] == "application/json"
    assert put["Tagging"] == "kind=transcript"  # the 90-day lifecycle rule keys on this tag
    body = json.loads(put["Body"])
    assert body["callId"] == "call-123" and body["tenantId"] == "t_acme"
    assert body["turns"] == [
        {"role": "caller", "text": "Hi, can I book a haircut?", "atSec": 1.0},
        {"role": "agent", "text": "Sure, what day works?", "atSec": 2.0},
    ]


async def test_call_ended_waits_for_a_slow_upload():
    gate = threading.Event()
    log = Log()

    class SlowS3(FakeS3):
        def put_object(self, **kw):
            gate.wait(0.3)
            return super().put_object(**kw)

    ev, eb, s3, _, _ = make(log=log, s3=SlowS3(log))
    await ev.ended(5, "caller_hangup")
    assert log.order == ["s3.put_object", "put_events:call.ended"]


async def test_transcript_roles_are_normalised_to_agent_and_caller():
    ev, _, s3, _, _ = make()
    await ev.turn("assistant", "Hello", 0.1)
    await ev.turn("user", "Hi", 0.2)
    await ev.ended(1, "caller_hangup")
    assert [t["role"] for t in json.loads(s3.puts[0]["Body"])["turns"]] == ["agent", "caller"]


async def test_transcript_upload_retries_then_succeeds():
    log = Log()
    ev, eb, s3, _, _ = make(log=log, s3=FakeS3(log, fail_times=2))
    await ev.ended(5, "caller_hangup")
    assert len(s3.puts) == 1
    assert eb.details[-1][1]["data"]["transcriptKey"].endswith("call-123.json")


async def test_call_ended_still_published_without_key_when_upload_keeps_failing():
    log = Log()
    ev, eb, s3, _, _ = make(log=log, s3=FakeS3(log, always_fail=True))
    await ev.ended(5, "error")  # must not raise
    ((_, detail),) = [x for x in eb.details if x[0] == "call.ended"]
    assert "transcriptKey" not in detail["data"]
    validate_data("call.ended", detail["data"])


async def test_put_events_retries_on_exception_and_on_failed_entries():
    log = Log()
    ev, eb, *_ = make(log=log, eb=FakeEventBridge(log, fail_times=1, failed_entries_times=1))
    await ev.started("+12145550123")
    await drain(ev)
    assert len(eb.calls) == 3
    assert log.order == ["put_events:call.started"]


async def test_put_events_gives_up_quietly_after_retries():
    log = Log()
    ev, eb, *_ = make(log=log, eb=FakeEventBridge(log, fail_times=99))
    await ev.ended(3, "caller_hangup")  # must not raise
    assert len([c for c in eb.calls if c[0]["DetailType"] == "call.ended"]) == 4  # 1 try + 3 retries


async def test_ended_is_published_once_and_unknown_reason_becomes_error():
    ev, eb, *_ = make()
    await ev.ended(10, "something_odd")
    await ev.ended(10, "caller_hangup")
    ended = [d for t, d in eb.details if t == "call.ended"]
    assert len(ended) == 1
    assert ended[0]["data"]["endReason"] == "error"


async def test_transcript_partial_throttled_to_two_per_second():
    ev, eb, _, clock, _ = make()
    for i in range(10):  # 10 turns inside one second
        clock.t = 100.0 + i * 0.1
        await ev.turn("caller", f"word {i}", i * 0.1)
    await drain(ev)
    partials = [d for t, d in eb.details if t == "transcript.partial"]
    assert len(partials) == 2  # t=0.0 and t=0.5
    for p in partials:
        validate_envelope(p, "transcript.partial")
        assert p["correlationId"] == "call-123" and p["tenantId"] == "t_acme"
        assert {"callId", "role", "text", "atSec"} <= set(p["data"])
    clock.t = 101.0  # next second opens a new window
    await ev.turn("agent", "later", 1.0)
    await drain(ev)
    assert len([1 for t, _ in eb.details if t == "transcript.partial"]) == 3


async def test_throttled_turns_are_still_kept_in_the_transcript():
    ev, _, s3, _, _ = make()
    for i in range(5):
        await ev.turn("caller", f"w{i}", i * 0.01)
    await ev.ended(1, "caller_hangup")
    assert len(json.loads(s3.puts[0]["Body"])["turns"]) == 5


async def test_turn_does_not_wait_for_aws():
    """The audio path must never wait on EventBridge: turn() returns while put_events is still blocked."""
    gate = threading.Event()
    log = Log()

    class Slow(FakeEventBridge):
        def put_events(self, Entries):
            gate.wait(2)
            return super().put_events(Entries)

    ev, eb, *_ = make(log=log, eb=Slow(log))
    await asyncio.wait_for(ev.turn("caller", "hello", 0.0), timeout=0.5)
    assert eb.calls == []  # still blocked in the worker thread
    gate.set()
    await drain(ev)
    assert len(eb.calls) == 1


async def test_partial_failure_never_raises_or_blocks_ended():
    log = Log()

    class Boom(FakeEventBridge):
        def put_events(self, Entries):
            if Entries[0]["DetailType"] == "transcript.partial":
                raise RuntimeError("nope")
            return super().put_events(Entries)

    ev, eb, *_ = make(log=log, eb=Boom(log))
    await ev.turn("caller", "hello", 0.0)
    await ev.ended(2, "caller_hangup")
    assert "put_events:call.ended" in log.order


async def test_no_partials_after_ended():
    ev, eb, _, clock, _ = make()
    await ev.ended(2, "caller_hangup")
    clock.t += 10
    await ev.turn("caller", "too late", 3.0)
    await drain(ev)
    assert [t for t, _ in eb.details] == ["call.ended"]


def test_mask_phone_matches_shared_helper():
    assert mask_phone("+12145550123") == MASKED
    assert mask_phone(None) == "unknown"
    assert mask_phone("") == "unknown"
    assert mask_phone("123") == "•••"
    assert mask_phone(MASKED) == MASKED
