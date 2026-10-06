"""Resolve the tenant for a call (dialed number) or a web chat (widget key) (owned by issue E5).

Uses SigV4 (ECS task role) against the internal resolver routes. The only identity inputs are the dialed number and
the widget key; nothing the model or the visitor says ever reaches this module."""
from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

from .sip import SipCallInfo


class ResolverError(Exception):
    """The resolver could not answer (timeout, 5xx, bad payload). Distinct from 'unknown number or widget' (None)."""


@dataclass(frozen=True)
class ResolvedTenant:
    tenant_id: str
    token: str = field(repr=False)   # call-scoped tenant token: given to ToolsClient, NEVER to the model, never logged
    state: str            # active | suspended | over_cap
    agent_name: str
    business_name: str
    timezone: str
    disclosure_line: str
    instructions: str
    voice_id: str | None
    language: str
    template_version: str


def _from_payload(p: dict) -> ResolvedTenant:
    try:
        a = p["agent"]
        return ResolvedTenant(
            tenant_id=p["tenantId"], token=p["token"], state=p["state"], agent_name=a["agentName"],
            business_name=a["businessName"], timezone=a["timezone"], disclosure_line=a["disclosureLine"],
            instructions=a["instructions"], voice_id=a.get("voiceId"), language=a.get("language", "en-US"),
            template_version=a["templateVersion"],
        )
    except (KeyError, TypeError) as e:
        raise ResolverError(f"malformed resolver payload: {e}") from e


Signer = Callable[[str, str, str], dict[str, str]]


class Resolver:
    def __init__(
        self,
        base_url: str | None = None,
        mode: str | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        signer: Signer | None = None,
    ):
        self.base_url = (base_url or os.environ.get("RESOLVER_URL", "")).rstrip("/")
        self.mode = mode or os.environ.get("RESOLVER_MODE", "remote")  # "static" for the W0-02 spike
        self._transport = transport
        self._signer = signer or _sigv4_headers

    async def resolve(self, info: SipCallInfo) -> ResolvedTenant | None:
        """Phone call: the dialed number decides the tenant. None = number not assigned."""
        if self.mode == "static":     # dev and the W0-02 spike only: the tenant is fixed by the environment, not by anyone's input
            return _from_payload(json.loads(os.environ["STATIC_TENANT_JSON"]))
        if not info.dialed:
            return None
        return await self._post("/internal/resolve/number", {"dialed": info.dialed, "caller": info.caller, "callId": info.call_id})

    async def resolve_widget(self, widget_key: str, call_id: str) -> ResolvedTenant | None:
        """Web chat: the widget key decides the tenant. None = unknown widget."""
        if self.mode == "static":
            return _from_payload(json.loads(os.environ["STATIC_TENANT_JSON"]))
        if not widget_key:
            return None
        return await self._post("/internal/resolve/widget", {"widgetKey": widget_key, "callId": call_id})

    async def _post(self, path: str, payload: dict) -> ResolvedTenant | None:
        body = json.dumps(payload)
        url = self.base_url + path
        try:
            headers = self._signer("POST", url, body)   # missing task-role credentials surface as ResolverError too
            async with httpx.AsyncClient(timeout=2.0, transport=self._transport) as client:
                r = await client.post(url, content=body, headers=headers)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            raise ResolverError(f"resolver unavailable: {type(e).__name__}") from e
        return _from_payload(data)


def _sigv4_headers(method: str, url: str, body: str) -> dict[str, str]:
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session

    creds = Session().get_credentials().get_frozen_credentials()
    req = AWSRequest(method=method, url=url, data=body, headers={"content-type": "application/json"})
    SigV4Auth(creds, "execute-api", os.environ.get("AWS_REGION", "us-east-1")).add_auth(req)
    return dict(req.headers.items())
