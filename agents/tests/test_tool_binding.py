import inspect

from admin.tools import make_admin_tools
from onboarding.tools import make_onboarding_tools


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


def test_no_tool_accepts_an_id_or_token_argument():
    for fn in make_onboarding_tools(FakeApi(), "onb1") + make_admin_tools(FakeApi()):
        assert not FORBIDDEN_PARAMS & set(inspect.signature(fn).parameters), fn.__name__


def test_onboarding_tools_are_bound_to_the_routed_onboarding():
    api = FakeApi()
    save = {f.__name__: f for f in make_onboarding_tools(api, "onb-REAL")}["save_business_basics"]
    save("Kemi Cuts", "barber", "Frisco, TX")
    assert api.calls[0][1] == "/internal/onboarding/onb-REAL/basics"


def test_healthcare_is_waitlisted_not_onboarded():
    api = FakeApi()
    save = {f.__name__: f for f in make_onboarding_tools(api, "onb1")}["save_business_basics"]
    out = save("Smile Dental", "dentist", "Plano")
    assert "not supported" in out and api.calls[0][1].endswith("/waitlist")


def test_admin_agent_has_no_apply_tool_and_relays_confirm_code():
    api = FakeApi({"summary": "Close on Thu Nov 26 (Thanksgiving).", "code": "4821"})
    tools = {f.__name__: f for f in make_admin_tools(api)}
    assert not any("apply" in name for name in tools)
    out = tools["propose_closed_date"]("2026-11-26", "Thanksgiving")
    assert "CONFIRM 4821" in out
