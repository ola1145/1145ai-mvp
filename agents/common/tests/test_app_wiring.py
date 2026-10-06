"""A1: entrypoints wire tools, system prompt, model and memory without touching AWS."""
import inspect

import pytest


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ONBOARDING_API_URL", "http://fake")
    monkeypatch.setenv("ONBOARDING_SERVICE_TOKEN", "svc")
    monkeypatch.setenv("TOOL_API_URL", "http://fake")
    monkeypatch.delenv("AGENTCORE_MEMORY_ID", raising=False)


def test_models_follow_the_brief_sonnet_for_onboarding_haiku_for_admin():
    import admin.app as admin_app
    import onboarding.app as onb_app
    assert "sonnet" in onb_app.MODEL_ID and "haiku" in admin_app.MODEL_ID


def test_entrypoints_take_payload_and_context():
    import admin.app as admin_app
    import onboarding.app as onb_app
    for mod in (admin_app, onb_app):
        assert list(inspect.signature(mod.invoke).parameters)[:2] == ["payload", "context"]


def test_memory_factory_is_disabled_without_memory_id():
    from common.memory import memory_factory_from_env
    from common.runtime import onboarding_turn
    assert memory_factory_from_env({})(onboarding_turn({"onboardingId": "O1", "text": "x"})) is None


def test_memory_factory_builds_agentcore_session_manager_from_turn(monkeypatch):
    import common.memory as memory
    captured = {}

    def fake_build(memory_id, session_id, actor_id, region):
        captured.update(memory_id=memory_id, session_id=session_id, actor_id=actor_id, region=region)
        return "SM"

    monkeypatch.setattr(memory, "_build_agentcore_session_manager", fake_build)
    from common.runtime import onboarding_turn
    f = memory.memory_factory_from_env({"AGENTCORE_MEMORY_ID": "mem-123", "AWS_REGION": "us-east-1"})
    assert f(onboarding_turn({"onboardingId": "O1", "text": "x"})) == "SM"
    assert captured == {"memory_id": "mem-123", "session_id": "onb-O1", "actor_id": "onb-O1", "region": "us-east-1"}
