"""A1 deploy helpers: pure planning plus dry-run default. No AWS calls are made here."""
import pytest

from deploy import plan
from deploy.plan import AGENTS, memory_name, ssm_names

ONB = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent1145_onboarding_dev-AbC123"
ADM = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent1145_admin_dev-XyZ789"


def test_ssm_names_match_what_the_router_reads():
    n = ssm_names("dev")
    assert n["onboarding"]["arn"] == "/1145/dev/agentcore/onboarding-arn"
    assert n["admin"]["arn"] == "/1145/dev/agentcore/admin-arn"
    assert n["onboarding"]["memory_id"] == "/1145/dev/agentcore/onboarding-memory-id"


def test_memory_names_are_valid_agentcore_names():
    import re
    for a in AGENTS:
        assert re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,47}", memory_name(a, "dev"))


def test_stage_is_validated():
    with pytest.raises(ValueError):
        ssm_names("dev; rm -rf /")


class FakeSsm:
    def __init__(self):
        self.puts = []

    def put_parameter(self, **kw):
        self.puts.append(kw)


def test_publish_is_dry_run_by_default():
    ssm = FakeSsm()
    out = plan.publish_arns("dev", {"onboarding": ONB, "admin": ADM}, ssm_client=ssm)
    assert ssm.puts == [] and len(out) == 2


def test_publish_apply_writes_both_arns_overwriting():
    ssm = FakeSsm()
    plan.publish_arns("dev", {"onboarding": ONB, "admin": ADM}, ssm_client=ssm, apply=True)
    assert {p["Name"]: p["Value"] for p in ssm.puts} == {
        "/1145/dev/agentcore/onboarding-arn": ONB,
        "/1145/dev/agentcore/admin-arn": ADM,
    }
    assert all(p["Overwrite"] and p["Type"] == "String" for p in ssm.puts)


def test_publish_rejects_non_runtime_arns():
    with pytest.raises(ValueError):
        plan.publish_arns("dev", {"onboarding": "not-an-arn", "admin": ADM}, ssm_client=FakeSsm(), apply=True)


def test_launch_commands_are_deterministic_and_set_memory_env():
    cmds = plan.launch_commands("dev", {"onboarding": "mem-o", "admin": "mem-a"}, region="us-east-1")
    flat = [" ".join(c) for c in cmds]
    assert any("onboarding/app.py" in c for c in flat) and any("admin/app.py" in c for c in flat)
    assert any("AGENTCORE_MEMORY_ID=mem-o" in c for c in flat) and any("AGENTCORE_MEMORY_ID=mem-a" in c for c in flat)
