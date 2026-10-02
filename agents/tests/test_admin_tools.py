import inspect

from admin.tools import make_admin_tools


class FakeApi:
    def __init__(self, post_reply=None):
        self.calls = []
        self.post_reply = post_reply or {}

    def post(self, path, body):
        self.calls.append(("POST", path, body))
        return self.post_reply

    def get(self, path, params=None):
        self.calls.append(("GET", path, params))
        return {}


FORBIDDEN_PARAMS = {"onboarding_id", "tenant_id", "tenant", "token", "tid"}


def test_no_admin_tool_accepts_an_id_or_token_argument():
    for fn in make_admin_tools(FakeApi()):
        assert not FORBIDDEN_PARAMS & set(inspect.signature(fn).parameters), fn.__name__


def test_admin_agent_has_no_apply_tool_and_relays_confirm_code():
    api = FakeApi({"summary": "Close on Thu Nov 26 (Thanksgiving).", "code": "4821"})
    tools = {f.__name__: f for f in make_admin_tools(api)}
    assert not any("apply" in name for name in tools)
    out = tools["propose_closed_date"]("2026-11-26", "Thanksgiving")
    assert "CONFIRM 4821" in out
