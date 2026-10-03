"""HTTP client for the tenant tool API. Holds the tenant token; the model only ever sees tool RESULTS."""
from __future__ import annotations

from typing import Any

import httpx

from .sip import booking_idempotency_key

FALLBACK = "I'm having trouble with that right now. Let me take a message so the team can call you back."


class ToolsClient:
    def __init__(self, base_url: str, token: str, call_id: str, timeout_s: float = 2.5):
        self._base = base_url.rstrip("/")
        self._headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
        self._call_id = call_id
        self._timeout = timeout_s

    def __repr__(self) -> str:
        return f"ToolsClient(base={self._base!r}, call_id={self._call_id!r})"   # never the token

    async def _post(self, path: str, body: dict[str, Any], extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as c:
                r = await c.post(self._base + path, json=body, headers={**self._headers, **(extra_headers or {})})
            data = r.json() if r.content else {}
            if r.status_code >= 400:
                return {"error": data.get("code", "error"), "sayToCaller": data.get("sayToCaller", FALLBACK)}
            return data
        except (httpx.HTTPError, ValueError, AttributeError):
            return {"error": "unavailable", "sayToCaller": FALLBACK}

    async def check_availability(self, date_from: str, date_to: str, service_id: str | None) -> dict[str, Any]:
        body = {"dateFrom": date_from, "dateTo": date_to, "maxResults": 3}
        if service_id:
            body["serviceId"] = service_id
        return await self._post("/v1/tools/availability", body)

    async def create_booking(self, slot_start: str, service_id: str, customer_name: str, email: str | None) -> dict[str, Any]:
        key = booking_idempotency_key(self._call_id, slot_start, service_id)
        customer = {"name": customer_name, **({"email": email} if email else {})}
        return await self._post("/v1/tools/bookings", {"slotStart": slot_start, "serviceId": service_id, "customer": customer}, {"idempotency-key": key})

    async def take_message(self, from_name: str, body: str, urgent: bool) -> dict[str, Any]:
        return await self._post("/v1/tools/messages", {"fromName": from_name, "body": body, "urgency": "urgent" if urgent else "normal"})

    async def search_knowledge(self, query: str) -> dict[str, Any]:
        return await self._post("/v1/tools/kb/search", {"query": query})

    async def lookup_caller(self) -> dict[str, Any]:
        return await self._post("/v1/tools/caller/lookup", {})

    async def request_handoff(self, reason: str) -> dict[str, Any]:
        return await self._post("/v1/tools/handoff", {"reason": reason})
