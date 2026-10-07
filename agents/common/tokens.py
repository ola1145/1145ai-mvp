"""
Per-invocation onboarding token (SEC-22, CR D1-3 section 1).

The onboarding API accepts only a short-lived HS256 token whose `onb` claim names ONE onboarding, and checks that the
path id equals it. The agent mints one per turn from `payload["onboardingId"]` (the router put it there from a
verified identity, never the model). The signing key is the former static ONBOARDING_SERVICE_TOKEN, now fetched from
Secrets Manager (common/secrets.py) and used only as an HMAC key, never sent.

Format and claims are exactly what services/provisioning/src/api/basics.ts mints and verifies; a golden-vector test
and, when tsx is installed, a test against the real verifier keep the two in lockstep.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time

AUDIENCE = "onboarding-api"
MAX_TTL_SECONDS = 900          # the API accepts up to an hour; the CR asks for 15 minutes or less
MIN_SECRET_CHARS = 16          # the API ignores shorter keys
_ONBOARDING_ID = re.compile(r"[A-Za-z0-9_-]{3,64}")   # services/provisioning/src/api/basics.ts ONBOARDING_ID_RE


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _compact(obj: dict) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode()


def mint_onboarding_token(onboarding_id: str, secret: str, ttl: int = MAX_TTL_SECONDS, now: int | None = None) -> str:
    if not isinstance(onboarding_id, str) or not _ONBOARDING_ID.fullmatch(onboarding_id):
        raise ValueError("onboarding id is not one the API accepts")
    if not isinstance(secret, str) or len(secret) < MIN_SECRET_CHARS:
        raise ValueError(f"signing key must be at least {MIN_SECRET_CHARS} characters")
    if not 0 < ttl <= MAX_TTL_SECONDS:
        raise ValueError(f"ttl must be between 1 and {MAX_TTL_SECONDS} seconds")
    issued = int(time.time()) if now is None else int(now)
    header = _b64(_compact({"alg": "HS256", "typ": "JWT"}))
    payload = _b64(_compact({"onb": onboarding_id, "aud": AUDIENCE, "iat": issued, "exp": issued + ttl}))
    signature = _b64(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"
