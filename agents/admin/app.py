"""
AgentCore Runtime entrypoint for the admin (owner copilot) agent (Haiku: frequent, short turns).

Router payload: {text, channel, displayName?, tenantToken, timezone?}. The token is minted by the router for this tenant and
goes only into the API client; it never enters the prompt or a tool argument. `timezone` (IANA, the tenant's) gives the
copilot the business clock, so "tomorrow" and "Thanksgiving" turn into the right dates (CR A3-1); without it the default
zone in common/clock.py is used. The router sets the runtime session id to `admin-<tid>-<channel>-<user>`, which keys
short-term memory. The agent proposes changes; it never applies them, and what the owner is asked to confirm reaches them
as the server wrote it (SEC-21, common/runtime.py enforce_relay).
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from admin.tools import make_admin_tools
from common.api import HttpApi
from common.clock import business_clock, clock_line
from common.memory import memory_factory_from_env
from common.runtime import admin_turn, bind_tools, enforce_relay, run_turn, wrap_tool

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    turn = admin_turn(payload, context)
    tz, known = business_clock(payload)
    proposals: list = []
    apis: list[HttpApi] = []

    def make_agent(session_manager):
        api = HttpApi(os.environ["TOOL_API_URL"], payload["tenantToken"])
        apis.append(api)
        # The default zone is fine for saying "tomorrow", never for writing the tenant's hours: only a zone the router
        # sent goes into a change.
        fns = bind_tools(make_admin_tools, api, now=lambda: datetime.now(tz), business_timezone=tz.key if known else None)
        tools = [tool(wrap_tool(fn, proposals)) for fn in fns]
        system = f"{SYSTEM}\n\n{clock_line(datetime.now(tz), tz)}"
        return Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=system, tools=tools, session_manager=session_manager)

    try:
        return run_turn(
            turn, make_agent=make_agent, memory_factory=memory_factory_from_env(os.environ),
            finalize=lambda reply: enforce_relay(reply, proposals),
        )
    finally:
        for api in apis:
            api.close()


if __name__ == "__main__":
    app.run()
