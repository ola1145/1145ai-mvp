"""AgentCore Runtime entrypoint for the admin (owner copilot) agent."""
from __future__ import annotations

import os
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from admin.tools import make_admin_tools
from common.api import HttpApi

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    api = HttpApi(os.environ["TOOL_API_URL"], payload["tenantToken"])   # admin-agent token minted by the router
    tools = [tool(fn) for fn in make_admin_tools(api)]
    agent = Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=SYSTEM, tools=tools)
    return {"reply": str(agent(payload.get("text", "")))}


if __name__ == "__main__":
    app.run()
