"""A1: stable session ids and short-term memory recall across invocations. No AWS, no Strands model calls."""
import re

import pytest

from common.runtime import Turn, admin_turn, onboarding_turn, run_turn
from common.sessions import SESSION_ID_RE, admin_session_id, memory_session_id, onboarding_session_id


# ---- session ids -----------------------------------------------------------------------------------------------

def test_onboarding_session_is_stable_and_channel_independent():
    web = onboarding_turn({"onboardingId": "01HX", "text": "hi", "channel": "web"})
    tg = onboarding_turn({"onboardingId": "01HX", "text": "hello again", "channel": "telegram"})
    assert web.session_id == tg.session_id == onboarding_session_id("01HX") == "onb-01HX"
    assert web.actor_id == tg.actor_id


def test_onboarding_sessions_differ_per_onboarding():
    a = onboarding_turn({"onboardingId": "A1", "text": "x"})
    b = onboarding_turn({"onboardingId": "B2", "text": "x"})
    assert a.session_id != b.session_id and a.actor_id != b.actor_id


def test_admin_session_id_matches_router_format():
    assert admin_session_id("t1", "telegram", "99") == "admin-t1-telegram-99"


class Ctx:
    def __init__(self, session_id):
        self.session_id = session_id


def test_admin_turn_uses_router_runtime_session_and_scopes_actor_to_it():
    t = admin_turn({"tenantToken": "tok", "text": "how many calls?"}, Ctx("admin-t1-telegram-99"))
    assert t.session_id == "admin-t1-telegram-99"
    assert t.actor_id == t.session_id          # tenant id is inside the session id, so actors never overlap across tenants


def test_admin_turn_without_runtime_session_has_no_memory_rather_than_a_shared_one():
    t = admin_turn({"tenantToken": "tok", "text": "hi"}, None)
    assert t.session_id is None


def test_memory_session_ids_are_valid_and_bounded():
    for raw in ["onb-01HX", "admin-t1-telegram-99", "admin-t1-telegram-+1 (214) 555/0100", "x" * 400, "-lead", ""]:
        sid = memory_session_id(raw)
        assert SESSION_ID_RE.fullmatch(sid), sid
        assert len(sid) <= 100
    assert memory_session_id("x" * 400) == memory_session_id("x" * 400)
    assert memory_session_id("a" * 400) != memory_session_id("a" * 399 + "b")


def test_missing_onboarding_id_is_rejected():
    with pytest.raises(KeyError):
        onboarding_turn({"text": "hi"})


# ---- memory recall across two invocations ----------------------------------------------------------------------

class FakeSessionManager:
    def __init__(self, history):
        self.history = history


class FakeMemory:
    """Stands in for AgentCore Memory: events keyed by (actor, session)."""

    def __init__(self):
        self.store = {}
        self.opened = []

    def __call__(self, turn: Turn):
        key = (turn.actor_id, memory_session_id(turn.session_id))
        self.opened.append(key)
        return FakeSessionManager(self.store.setdefault(key, []))


def fake_agent_factory(sm):
    def agent(text):
        sm.history.append(("user", text))
        m = re.search(r"my shop is (.+)", " ".join(t for r, t in sm.history if r == "user"), re.I)
        if "what's my shop" in text.lower():
            reply = f"You told me it's {m.group(1)}." if m else "I don't think you've said yet."
        else:
            reply = "Got it."
        sm.history.append(("agent", reply))
        return reply
    return agent


def test_recall_across_two_invocations_and_channels():
    mem = FakeMemory()
    t1 = onboarding_turn({"onboardingId": "O1", "text": "my shop is Kemi Cuts", "channel": "telegram"})
    t2 = onboarding_turn({"onboardingId": "O1", "text": "what's my shop called?", "channel": "web"})
    assert run_turn(t1, make_agent=fake_agent_factory, memory_factory=mem)["reply"] == "Got it."
    assert "Kemi Cuts" in run_turn(t2, make_agent=fake_agent_factory, memory_factory=mem)["reply"]
    assert len(mem.store) == 1


def test_no_recall_across_onboardings():
    mem = FakeMemory()
    run_turn(onboarding_turn({"onboardingId": "O1", "text": "my shop is Kemi Cuts"}), make_agent=fake_agent_factory, memory_factory=mem)
    out = run_turn(onboarding_turn({"onboardingId": "O2", "text": "what's my shop called?"}), make_agent=fake_agent_factory, memory_factory=mem)
    assert "Kemi" not in out["reply"] and len(mem.store) == 2


def test_no_recall_across_tenants_even_with_same_channel_user():
    mem = FakeMemory()
    a = admin_turn({"tenantToken": "a", "text": "my shop is Alpha"}, Ctx("admin-tA-telegram-99"))
    b = admin_turn({"tenantToken": "b", "text": "what's my shop called?"}, Ctx("admin-tB-telegram-99"))
    run_turn(a, make_agent=fake_agent_factory, memory_factory=mem)
    assert "Alpha" not in run_turn(b, make_agent=fake_agent_factory, memory_factory=mem)["reply"]


def test_no_session_means_no_memory_opened():
    mem = FakeMemory()
    t = admin_turn({"tenantToken": "a", "text": "hello"}, None)
    out = run_turn(t, make_agent=lambda sm: (lambda text: "ok"), memory_factory=mem)
    assert out["reply"] == "ok" and mem.opened == []


# ---- failure handling ------------------------------------------------------------------------------------------

def test_agent_crash_returns_a_human_fallback_not_a_stack_trace():
    def boom(sm):
        def agent(text):
            raise RuntimeError("bedrock throttled secret-token-123")
        return agent
    out = run_turn(onboarding_turn({"onboardingId": "O1", "text": "hi"}), make_agent=boom, memory_factory=FakeMemory())
    assert "secret-token" not in out["reply"] and "RuntimeError" not in out["reply"]
    assert 0 < len(out["reply"]) < 200


def test_memory_outage_degrades_to_stateless_instead_of_failing_the_turn():
    def broken_memory(turn):
        raise ConnectionError("memory down")
    out = run_turn(onboarding_turn({"onboardingId": "O1", "text": "hi"}), make_agent=lambda sm: (lambda t: f"sm={sm}"), memory_factory=broken_memory)
    assert out["reply"] == "sm=None"


def test_oversized_text_is_truncated():
    seen = []
    t = onboarding_turn({"onboardingId": "O1", "text": "a" * 50_000})
    run_turn(t, make_agent=lambda sm: (lambda text: seen.append(text) or "ok"), memory_factory=FakeMemory())
    assert len(seen[0]) <= 4000
