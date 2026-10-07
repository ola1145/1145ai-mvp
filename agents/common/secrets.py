"""
Where the onboarding signing key comes from (SEC-22): Secrets Manager, fetched at run time and cached for a few minutes.

Order, first one configured wins and a configured source that fails is an error (no quiet fall back to a weaker one):
  1. ONBOARDING_SERVICE_TOKEN_SECRET_ARN  a dedicated secret: a bare string, or JSON {"current": ...} (what D9 reads)
  2. RUNTIME_SECRET_ID                    the runtime secret `1145/<stage>/runtime`, JSON key ONBOARDING_SERVICE_TOKEN
                                          (what the onboarding API and the router read)
  3. ONBOARDING_SERVICE_TOKEN             local development only; deployed runtimes are launched without it
The execution role needs `secretsmanager:GetSecretValue` on whichever secret is used (agents/deploy/README.md).
The value is never logged and never appears in an error.
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable, Mapping

from common.tokens import MIN_SECRET_CHARS

CACHE_SECONDS = 300


class SecretUnavailable(RuntimeError):
    """The signing key could not be loaded or is unusable. The message never contains the value."""


_cache: dict[str, tuple[float, str]] = {}


def reset_cache() -> None:
    _cache.clear()


def _parse(secret_string: str, runtime_json: bool) -> str:
    raw = (secret_string or "").strip()
    if not raw.startswith("{"):
        return raw if not runtime_json else ""
    try:
        obj = json.loads(raw)
    except ValueError:
        return ""
    if not isinstance(obj, dict):
        return ""
    for key in (("ONBOARDING_SERVICE_TOKEN",) if runtime_json else ("current", "ONBOARDING_SERVICE_TOKEN")):
        if isinstance(obj.get(key), str):
            return obj[key].strip()
    return ""


def _client(env: Mapping[str, str]) -> Any:
    import boto3  # lazy: unit tests and `make test` never need AWS

    return boto3.client("secretsmanager", region_name=env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION"))


def load_onboarding_signing_secret(
    env: Mapping[str, str], *, client: Any = None, clock: Callable[[], float] = time.monotonic,
) -> str:
    dedicated = env.get("ONBOARDING_SERVICE_TOKEN_SECRET_ARN", "")
    runtime = env.get("RUNTIME_SECRET_ID", "")
    secret_id, runtime_json = (dedicated, False) if dedicated else (runtime, True)

    if not secret_id:
        value = env.get("ONBOARDING_SERVICE_TOKEN", "")
        if len(value) < MIN_SECRET_CHARS:
            raise SecretUnavailable("no onboarding signing key is configured")
        return value

    hit = _cache.get(secret_id)
    now = clock()
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        raw = (client or _client(env)).get_secret_value(SecretId=secret_id).get("SecretString") or ""
    except Exception as e:  # noqa: BLE001 - AccessDenied, throttling, missing: all the same to the caller
        raise SecretUnavailable(f"could not read the onboarding signing key ({type(e).__name__})") from None
    value = _parse(raw, runtime_json)
    if len(value) < MIN_SECRET_CHARS:
        raise SecretUnavailable("the onboarding signing key in Secrets Manager is missing or too short")
    _cache[secret_id] = (now, value)
    return value
