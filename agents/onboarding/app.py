"""
AgentCore Runtime entrypoint for the onboarding agent (Sonnet: rare, high-value conversations).

Router payload: {text, channel, displayName?, onboardingId}. The onboarding id came from the verified identity route.
Short-term memory is keyed by runtime session id `onb-<onboardingId>`, so web chat and Telegram share one thread.
Deploy: agents/deploy/README.md (owner follow-up; nothing here deploys itself).
"""
from __future__ import annotations

import os
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from common.api import HttpApi
from common.memory import memory_factory_from_env
from common.runtime import onboarding_turn, run_turn
from onboarding.tools import make_onboarding_tools

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    turn = onboarding_turn(payload)

    def make_agent(session_manager):
        api = HttpApi(os.environ["ONBOARDING_API_URL"], os.environ["ONBOARDING_SERVICE_TOKEN"])
        tools = [tool(fn) for fn in make_onboarding_tools(api, payload["onboardingId"])]
        return Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=SYSTEM, tools=tools, session_manager=session_manager)

    return run_turn(turn, make_agent=make_agent, memory_factory=memory_factory_from_env(os.environ))


if __name__ == "__main__":
    app.run()
