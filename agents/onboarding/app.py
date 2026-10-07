"""
AgentCore Runtime entrypoint for the onboarding agent (Sonnet: rare, high-value conversations).

Router payload: {text, channel, displayName?, onboardingId, messageId?}. The onboarding id came from the verified identity
route. Short-term memory is keyed by `onb-<onboardingId>`, so web chat and Telegram share one thread.

Credentials: the onboarding API accepts only a short-lived signed token that names one onboarding (SEC-22). Each turn mints
one from the routed onboarding id with a signing key read from Secrets Manager (common/secrets.py). Tools never see it.
`messageId` (the owner's channel message id, if the router sends it) goes out as the `X-1145-Message-Id` header on every
call so the facts decisions it triggers are auditable. Deploy: agents/deploy/README.md (nothing here deploys itself).
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

from common.api import HttpApi
from common.memory import memory_factory_from_env
from common.runtime import bind_tools, onboarding_context, onboarding_turn, run_turn
from common.secrets import load_onboarding_signing_secret
from common.tokens import mint_onboarding_token
from onboarding.tools import make_onboarding_tools

app = BedrockAgentCoreApp()
SYSTEM = (Path(__file__).parent / "system_prompt.md").read_text()
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")

_MESSAGE_ID = re.compile(r"[A-Za-z0-9_.:@-]{1,128}")   # what the API accepts for X-1145-Message-Id


def message_id_header(payload: dict) -> dict[str, str]:
    mid = payload.get("messageId")
    return {"X-1145-Message-Id": mid} if isinstance(mid, str) and _MESSAGE_ID.fullmatch(mid) else {}


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    turn = onboarding_turn(payload)
    onboarding_id = payload["onboardingId"]
    apis: list[HttpApi] = []

    def make_agent(session_manager):
        token = mint_onboarding_token(onboarding_id, load_onboarding_signing_secret(os.environ))
        api = HttpApi(os.environ["ONBOARDING_API_URL"], token, headers=message_id_header(payload))
        apis.append(api)
        # owner_text is what the owner actually typed this turn: tools use it to refuse approvals the owner did not give.
        tools = [tool(fn) for fn in bind_tools(make_onboarding_tools, api, onboarding_id, owner_text=turn.text)]
        system = f"{SYSTEM}\n\n{onboarding_context(payload)}"
        return Agent(model=BedrockModel(model_id=MODEL_ID), system_prompt=system, tools=tools, session_manager=session_manager)

    try:
        return run_turn(turn, make_agent=make_agent, memory_factory=memory_factory_from_env(os.environ))
    finally:
        for api in apis:
            api.close()


if __name__ == "__main__":
    app.run()
