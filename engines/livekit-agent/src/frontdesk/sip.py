"""Pure helpers: turn LiveKit SIP participant attributes into a call identity. No LiveKit import, so it is unit-testable."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

_E164 = re.compile(r"^\+[1-9]\d{6,14}$")


def normalize_e164(raw: str | None, default_country: str = "1") -> str | None:
    if not raw:
        return None
    s = raw.strip()
    if s.lower().startswith(("sip:", "tel:")):
        s = s.split(":", 1)[1].split("@", 1)[0].split(";", 1)[0]
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if plus:
        cand = "+" + digits
    elif len(digits) == 10:
        cand = "+" + default_country + digits
    elif len(digits) == 11 and digits.startswith(default_country):
        cand = "+" + digits
    else:
        cand = "+" + digits
    return cand if _E164.match(cand) else None


@dataclass(frozen=True)
class SipCallInfo:
    dialed: str | None   # the tenant DID: decides the tenant (the one rule)
    caller: str | None   # carrier caller ID: a hint, NOT identity
    call_id: str


def sip_info_from_attributes(attrs: dict[str, str]) -> SipCallInfo:
    """LiveKit sets these on the SIP participant: sip.trunkPhoneNumber (dialed), sip.phoneNumber (caller), sip.callID."""
    return SipCallInfo(
        dialed=normalize_e164(attrs.get("sip.trunkPhoneNumber")),
        caller=normalize_e164(attrs.get("sip.phoneNumber")),
        call_id=attrs.get("sip.callID") or attrs.get("sip.callIDFull") or "",
    )


def booking_idempotency_key(call_id: str, slot_start: str, service_id: str) -> str:
    """Same call + same slot + same service = same booking, even if the LLM calls the tool twice."""
    return "bk-" + hashlib.sha256(f"{call_id}|{slot_start}|{service_id}".encode()).hexdigest()[:32]
