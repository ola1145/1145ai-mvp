"""
Owner-run deploy helper for the two AgentCore runtimes. Importing this does nothing; every command that touches AWS
is dry-run unless --apply is passed, and `plan` / `launch` only PRINT the starter-toolkit commands.

  cd agents
  uv run python -m deploy.plan plan --stage dev
  uv run python -m deploy.plan create-memory --stage dev --apply     # short-term memory, one per agent
  # run the printed `agentcore configure` / `agentcore launch` commands, then:
  uv run python -m deploy.plan publish-arns --stage dev --onboarding-arn <arn> --admin-arn <arn> --apply

See agents/deploy/README.md for the full runbook and the IAM the execution role needs.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

AGENTS = ("onboarding", "admin")
_STAGE_RE = re.compile(r"[a-z][a-z0-9-]{0,20}")
_RUNTIME_ARN_RE = re.compile(r"arn:[a-z-]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime/[A-Za-z0-9_-]+(/.*)?")
EVENT_EXPIRY_DAYS = 30  # short-term memory: onboarding takes minutes to days, copilot threads are rolling


def _stage(stage: str) -> str:
    if not _STAGE_RE.fullmatch(stage):
        raise ValueError(f"bad stage {stage!r}")
    return stage


def memory_name(agent: str, stage: str) -> str:
    return f"agent1145_{agent}_{_stage(stage).replace('-', '_')}"


def ssm_names(stage: str) -> dict[str, dict[str, str]]:
    base = f"/1145/{_stage(stage)}/agentcore"
    return {a: {"arn": f"{base}/{a}-arn", "memory_id": f"{base}/{a}-memory-id"} for a in AGENTS}


def launch_commands(stage: str, memory_ids: dict[str, str], region: str, execution_role_arn: str = "<EXECUTION_ROLE_ARN>") -> list[list[str]]:
    """Starter-toolkit commands, run from agents/ so `common/` ships with each runtime. Verify flags with `agentcore <cmd> --help`."""
    _stage(stage)
    cmds: list[list[str]] = []
    for a in AGENTS:
        name = f"agent1145_{a}_{stage.replace('-', '_')}"
        cmds.append(["agentcore", "configure", "--entrypoint", f"{a}/app.py", "--name", name,
                     "--execution-role", execution_role_arn, "--region", region, "--non-interactive"])
        env = [f"AGENTCORE_MEMORY_ID={memory_ids[a]}"]
        env += ["ONBOARDING_API_URL=<url>", "ONBOARDING_SERVICE_TOKEN=<from Secrets Manager>"] if a == "onboarding" else ["TOOL_API_URL=<url>"]
        cmds.append(["agentcore", "launch", "--agent", name] + [x for e in env for x in ("--env", e)])
    return cmds


def create_memories(stage: str, *, client: Any = None, apply: bool = False, region: str = "us-east-1") -> dict[str, str]:
    """Create one short-term (no long-term strategies) memory per agent. Returns agent -> memory id (or name when dry-run)."""
    out: dict[str, str] = {}
    for a in AGENTS:
        name = memory_name(a, stage)
        if not apply:
            out[a] = name
            continue
        if client is None:
            from bedrock_agentcore.memory import MemoryClient
            client = MemoryClient(region_name=region)
        mem = client.create_memory_and_wait(name=name, strategies=[], description=f"1145 {a} agent short-term memory ({stage})",
                                            event_expiry_days=EVENT_EXPIRY_DAYS)
        out[a] = mem.get("id") or mem["memoryId"]
    return out


def publish_arns(stage: str, arns: dict[str, str], *, ssm_client: Any = None, apply: bool = False,
                 memory_ids: dict[str, str] | None = None) -> dict[str, str]:
    names = ssm_names(stage)
    puts: dict[str, str] = {}
    for a in AGENTS:
        if not _RUNTIME_ARN_RE.fullmatch(arns[a]):
            raise ValueError(f"{a}: {arns[a]!r} is not an AgentCore runtime ARN")
        puts[names[a]["arn"]] = arns[a]
        if memory_ids and a in memory_ids:
            puts[names[a]["memory_id"]] = memory_ids[a]
    if apply:
        if ssm_client is None:
            import boto3
            ssm_client = boto3.client("ssm")
        for name, value in puts.items():
            ssm_client.put_parameter(Name=name, Value=value, Type="String", Overwrite=True)
    return puts


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="deploy.plan")
    p.add_argument("command", choices=["plan", "create-memory", "publish-arns"])
    p.add_argument("--stage", default="dev")
    p.add_argument("--region", default="us-east-1")
    p.add_argument("--apply", action="store_true", help="actually call AWS (default is a dry run)")
    p.add_argument("--onboarding-arn")
    p.add_argument("--admin-arn")
    p.add_argument("--onboarding-memory-id")
    p.add_argument("--admin-memory-id")
    a = p.parse_args(argv)

    if a.command == "plan":
        mem = {k: v or f"<{k}-memory-id>" for k, v in (("onboarding", a.onboarding_memory_id), ("admin", a.admin_memory_id))}
        for c in launch_commands(a.stage, mem, a.region):
            print(" ".join(c))
        return 0
    if a.command == "create-memory":
        print(json.dumps(create_memories(a.stage, apply=a.apply, region=a.region), indent=2))
        return 0
    if not (a.onboarding_arn and a.admin_arn):
        print("publish-arns needs --onboarding-arn and --admin-arn", file=sys.stderr)
        return 2
    mids = {k: v for k, v in (("onboarding", a.onboarding_memory_id), ("admin", a.admin_memory_id)) if v}
    print(json.dumps(publish_arns(a.stage, {"onboarding": a.onboarding_arn, "admin": a.admin_arn}, apply=a.apply, memory_ids=mids), indent=2))
    if not a.apply:
        print("dry run; pass --apply to write these to SSM", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
