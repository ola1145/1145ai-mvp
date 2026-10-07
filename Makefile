.PHONY: bootstrap test test-ts test-py typecheck synth briefs style deps-batch evals lint-workflows

bootstrap:
	pnpm install
	cd engines/livekit-agent && uv sync
	cd agents && uv sync

test: test-ts test-py

test-ts:
	pnpm vitest run

test-py:
	cd engines/livekit-agent && uv run --locked pytest -q
	cd agents && uv run --locked pytest -q

typecheck:
	pnpm typecheck

synth:
	cd infra/cdk && pnpm cdk synth -q

deps-batch:
	pnpm exec tsx scripts/ci/dep-batch.ts

briefs:
	pnpm orchestrate:briefs

style:
	pnpm exec tsx scripts/ci/check-style.ts

# Scenario suite against the scripted fakes and the offline judge (free, deterministic). Live runs belong to a nightly job.
evals:
	pnpm exec tsx evals/src/cli.ts --runs 5

# Every workflow: actions pinned to a commit SHA, no allowed_bots "*", no untrusted event text in scripts or prompts.
lint-workflows:
	pnpm exec tsx scripts/ci/check-workflows.ts .github/workflows
