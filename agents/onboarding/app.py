"""AgentCore Runtime entrypoint for the onboarding agent. Deploy with the AgentCore starter toolkit (see task W1-16)."""
from __future__ import annotations

import os
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from common.api import HttpApi
from onboarding.tools import make_onboarding_tools

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    onboarding_id = payload["onboardingId"]          # set by the router from the verified identity route
    api = HttpApi(os.environ["ONBOARDING_API_URL"], os.environ["ONBOARDING_SERVICE_TOKEN"])
    tools = [tool(fn) for fn in make_onboarding_tools(api, onboarding_id)]
    # TODO(W1-16): AgentCore Memory (short-term) keyed by runtime session id = f"onb-{onboarding_id}" so WhatsApp -> web chat continues.
    agent = Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=SYSTEM, tools=tools)
    result = agent(payload.get("text", ""))
    return {"reply": str(result)}


if __name__ == "__main__":
    app.run()
