"""Sync HTTP client for 1145 internal APIs. Credentials are bound at construction; tools never receive them."""
from __future__ import annotations

from typing import Any, Protocol

import httpx


class Api(Protocol):
    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]: ...
    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...


class HttpApi:
    def __init__(self, base_url: str, bearer_token: str, timeout_s: float = 8.0):
        self._c = httpx.Client(base_url=base_url, timeout=timeout_s, headers={"authorization": f"Bearer {bearer_token}"})

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._wrap(lambda: self._c.post(path, json=body))

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._wrap(lambda: self._c.get(path, params=params))

    @staticmethod
    def _wrap(call) -> dict[str, Any]:
        try:
            r = call()
            data = r.json() if r.content else {}
            return data if r.status_code < 400 else {"error": data.get("code", "error"), "message": data.get("message", "")}
        except (httpx.HTTPError, ValueError) as e:
            return {"error": "unavailable", "message": str(e)}


def as_data(text: str) -> str:
    """Wrap third-party or stored text so the model treats it as data, not instructions."""
    return f"<data>\n{text}\n</data>"
