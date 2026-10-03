"""
AgentCore Runtime entrypoint for the admin (owner copilot) agent (Haiku: frequent, short turns).

Router payload: {text, channel, displayName?, tenantToken}. The token is minted by the router for this tenant and goes
only into the API client; it never enters the prompt or a tool argument. The router sets the runtime session id to
`admin-<tid>-<channel>-<user>`, which keys short-term memory. The agent proposes changes; it never applies them.
"""
from __future__ import annotations

import os
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from admin.tools import make_admin_tools
from common.api import HttpApi
from common.memory import memory_factory_from_env
from common.runtime import admin_turn, run_turn

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    turn = admin_turn(payload, context)

    def make_agent(session_manager):
        api = HttpApi(os.environ["TOOL_API_URL"], payload["tenantToken"])
        tools = [tool(fn) for fn in make_admin_tools(api)]
        return Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=SYSTEM, tools=tools, session_manager=session_manager)

    return run_turn(turn, make_agent=make_agent, memory_factory=memory_factory_from_env(os.environ))


if __name__ == "__main__":
    app.run()
