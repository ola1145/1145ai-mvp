"""
AgentCore Memory (short-term) wiring. A memory factory takes a Turn and returns a Strands session manager, or None
when memory is off. Short-term memory is keyed by (actor_id, session_id); both come from the router-verified
session id, so one owner's thread never mixes with another's, and onboarding continues across web chat and Telegram.

The memory resource itself is created by agents/deploy (scripts/create_memory.py) and its id arrives as
AGENTCORE_MEMORY_ID. Without it the agents run stateless (local dev, tests).
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Mapping

from common.sessions import memory_session_id

log = logging.getLogger("agents.memory")

MemoryFactory = Callable[[Any], Any]  # Turn -> session manager | None


def _build_agentcore_session_manager(memory_id: str, session_id: str, actor_id: str, region: str | None) -> Any:
    # Imported lazily so unit tests and `make test` never need AWS credentials or boto sessions.
    from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
    from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

    config = AgentCoreMemoryConfig(memory_id=memory_id, session_id=session_id, actor_id=actor_id)
    return AgentCoreMemorySessionManager(agentcore_memory_config=config, region_name=region)


def memory_factory_from_env(env: Mapping[str, str]) -> MemoryFactory:
    memory_id = env.get("AGENTCORE_MEMORY_ID", "")
    region = env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION")

    def factory(turn) -> Any:
        if not memory_id or not turn.session_id:
            return None
        return _build_agentcore_session_manager(
            memory_id, memory_session_id(turn.session_id), memory_session_id(turn.actor_id), region
        )

    return factory
