"""
Admin (owner copilot) tools. The tenant token is bound in the Api client by the router; tools never accept a
tenant id. The agent can READ and PROPOSE. It has no apply tool: the owner replies "CONFIRM 1234", which the
router applies deterministically with an owner token (and price changes also need dashboard step-up).
"""
from __future__ import annotations

import json
from typing import Callable

from common.api import Api, as_data


def make_admin_tools(api: Api) -> list[Callable[..., str]]:
    def summary_report(from_date: str, to_date: str) -> str:
        """Calls, bookings, messages, sentiment and minutes used between two dates (YYYY-MM-DD)."""
        return as_data(json.dumps(api.get("/v1/admin/reports/summary", {"from": from_date, "to": to_date})))

    def list_bookings(from_datetime: str, to_datetime: str) -> str:
        """Bookings between two ISO 8601 date-times."""
        return as_data(json.dumps(api.get("/v1/admin/bookings", {"from": from_datetime, "to": to_datetime})))

    def recent_conversations(limit: int = 10) -> str:
        """Most recent calls and chats with summary and sentiment."""
        return as_data(json.dumps(api.get("/v1/admin/conversations", {"limit": max(1, min(limit, 50))})))

    def _propose(kind: str, payload: dict) -> str:
        r = api.post("/v1/admin/changes", {"kind": kind, "payload": payload})
        if "error" in r:
            return "Could not prepare that change."
        extra = " Price changes also need a tap in the dashboard." if r.get("requiresStepUp") else ""
        return f"Tell the owner: {r['summary']} Reply CONFIRM {r['code']} to apply it.{extra}"

    def propose_hours_change(new_hours_in_owners_words: str) -> str:
        """Prepare a change to opening hours. Nothing changes until the owner confirms with the code."""
        return _propose("hours", {"text": new_hours_in_owners_words})

    def propose_closed_date(date: str, reason: str = "") -> str:
        """Prepare closing the business on a date (YYYY-MM-DD). Nothing changes until the owner confirms."""
        return _propose("closed_date", {"date": date, "reason": reason})

    def propose_service_change(service_name: str, new_price_dollars: float | None = None, new_duration_minutes: int | None = None, active: bool | None = None) -> str:
        """Prepare a change to a service's price, duration or availability. Nothing changes until the owner confirms."""
        patch = {k: v for k, v in {"priceCents": None if new_price_dollars is None else round(new_price_dollars * 100), "durationMin": new_duration_minutes, "active": active}.items() if v is not None}
        return _propose("service", {"serviceName": service_name, "patch": patch})

    return [summary_report, list_bookings, recent_conversations, propose_hours_change, propose_closed_date, propose_service_change]
