"""Resolve the tenant for a call from the dialed number. Uses SigV4 (ECS task role) against the internal resolver route."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import httpx

from .sip import SipCallInfo


@dataclass(frozen=True)
class ResolvedTenant:
    tenant_id: str
    token: str            # call-scoped tenant token: given to ToolsClient, NEVER to the model
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
    a = p["agent"]
    return ResolvedTenant(
        tenant_id=p["tenantId"], token=p["token"], state=p["state"], agent_name=a["agentName"],
        business_name=a["businessName"], timezone=a["timezone"], disclosure_line=a["disclosureLine"],
        instructions=a["instructions"], voice_id=a.get("voiceId"), language=a.get("language", "en-US"),
        template_version=a["templateVersion"],
    )


class Resolver:
    def __init__(self, base_url: str | None = None, mode: str | None = None):
        self.base_url = base_url or os.environ.get("RESOLVER_URL", "")
        self.mode = mode or os.environ.get("RESOLVER_MODE", "remote")  # "static" for the W0-02 spike

    async def resolve(self, info: SipCallInfo) -> ResolvedTenant | None:
        if not info.dialed:
            return None
        if self.mode == "static":
            return _from_payload(json.loads(os.environ["STATIC_TENANT_JSON"]))
        body = json.dumps({"dialed": info.dialed, "caller": info.caller, "callId": info.call_id})
        headers = _sigv4_headers("POST", f"{self.base_url}/internal/resolve/number", body)
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.post(f"{self.base_url}/internal/resolve/number", content=body, headers=headers)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return _from_payload(r.json())


def _sigv4_headers(method: str, url: str, body: str) -> dict[str, str]:
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session

    creds = Session().get_credentials().get_frozen_credentials()
    req = AWSRequest(method=method, url=url, data=body, headers={"content-type": "application/json"})
    SigV4Auth(creds, "execute-api", os.environ.get("AWS_REGION", "us-east-1")).add_auth(req)
    return dict(req.headers.items())
