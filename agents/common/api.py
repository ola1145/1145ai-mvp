"""
Sync HTTP client for 1145 internal APIs. Credentials are bound at construction; tools never receive them.

What a tool gets back is a plain dict. Success bodies come back as they are (a JSON list becomes {"items": [...]}, and
a next-page cursor from the `X-Next-Cursor` header becomes `nextCursor`). Failures come back as
{"error": <code>, "status": <http status>, "message": <for logs>, "say"?: <the server's own natural line>,
"retryAfterSec"?: <on 429>} so tools can react to what the API said instead of treating every failure alike.
"""
from __future__ import annotations

import re
from typing import Any, Mapping, Protocol

import httpx

DEFAULT_RETRY_AFTER_SEC = 5
MAX_RETRY_AFTER_SEC = 3600

_STATUS_CODES = {
    400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict",
    422: "invalid", 428: "step_up_required", 429: "rate_limited", 501: "not_implemented", 502: "unavailable",
    503: "unavailable", 504: "unavailable",
}


class Api(Protocol):
    def post(self, path: str, body: dict[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, Any]: ...
    def get(self, path: str, params: dict[str, Any] | None = None, headers: Mapping[str, str] | None = None) -> dict[str, Any]: ...


def _retry_after(response: httpx.Response, data: Any) -> int:
    raw = response.headers.get("retry-after")
    value: Any = None
    if raw is not None and re.fullmatch(r"\d{1,9}", raw.strip()):
        value = int(raw.strip())
    elif isinstance(data, dict) and isinstance(data.get("retryAfterSec"), (int, float)) and not isinstance(data.get("retryAfterSec"), bool):
        value = int(data["retryAfterSec"])
    if value is None:
        return DEFAULT_RETRY_AFTER_SEC
    return max(1, min(int(value), MAX_RETRY_AFTER_SEC))


def _error_code(status: int, data: Any) -> str:
    if isinstance(data, dict):
        for key in ("code", "error"):
            if isinstance(data.get(key), str) and data[key]:
                return data[key]
    return _STATUS_CODES.get(status, "error")


class HttpApi:
    def __init__(
        self, base_url: str, bearer_token: str, timeout_s: float = 15.0, *,
        headers: Mapping[str, str] | None = None, transport: httpx.BaseTransport | None = None,
    ):
        """`headers` are sent on every call (for context the router vouches for, like the inbound message id)."""
        base = {k: v for k, v in (headers or {}).items() if k.lower() != "authorization"}
        self._c = httpx.Client(
            base_url=base_url, timeout=timeout_s, transport=transport,
            headers={**base, "authorization": f"Bearer {bearer_token}"},
        )

    def post(self, path: str, body: dict[str, Any], headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        return self._wrap(lambda: self._c.post(path, json=body, headers=self._extra(headers)))

    def get(self, path: str, params: dict[str, Any] | None = None, headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        return self._wrap(lambda: self._c.get(path, params=params, headers=self._extra(headers)))

    def close(self) -> None:
        self._c.close()

    @staticmethod
    def _extra(headers: Mapping[str, str] | None) -> dict[str, str]:
        """Per-call headers can add context but never replace the credential."""
        return {k: v for k, v in (headers or {}).items() if k.lower() != "authorization"}

    @staticmethod
    def _wrap(call) -> dict[str, Any]:
        try:
            r = call()
        except httpx.HTTPError as e:
            # The class name is enough for logs; the text can carry URLs and headers.
            return {"error": "unavailable", "message": type(e).__name__}
        try:
            data = r.json() if r.content else {}
        except ValueError:
            data = {}

        if r.status_code >= 400:
            out: dict[str, Any] = {
                "error": _error_code(r.status_code, data), "status": r.status_code,
                "message": str(data.get("message") or "") if isinstance(data, dict) else "",
            }
            say = data.get("sayToCaller") if isinstance(data, dict) else None
            if isinstance(say, str) and say.strip():
                out["say"] = say.strip()
            if r.status_code == 429:
                out["retryAfterSec"] = _retry_after(r, data)
            return out

        cursor = r.headers.get("x-next-cursor")
        if isinstance(data, list):
            data = {"items": data}
        elif not isinstance(data, dict):
            data = {"value": data}
        if cursor and "nextCursor" not in data:
            data = {**data, "nextCursor": cursor}
        return data


_ANGLES = str.maketrans({"<": "&lt;", ">": "&gt;", "＜": "&lt;", "＞": "&gt;"})
_BAD_SOURCE = re.compile(r"[^a-z0-9._-]+")


def as_data(text: str, source: str | None = None) -> str:
    """
    Wrap third-party or stored text so the model treats it as data, not instructions (SEC-04).

    Angle brackets inside the text are escaped, so nothing in it can close this block or open another one. `source` says
    where the text came from (`<data source="owner-website">`); callers should always give it. It is reduced to a short
    lowercase token so it cannot break out of its attribute either. Without one the block is a plain `<data>`.
    """
    body = str(text).translate(_ANGLES)
    if source is None:
        return f"<data>\n{body}\n</data>"
    label = _BAD_SOURCE.sub("-", str(source).lower()).strip("-.")[:40] or "untrusted"
    return f'<data source="{label}">\n{body}\n</data>'
