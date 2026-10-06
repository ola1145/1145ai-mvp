.PHONY: bootstrap test test-ts test-py typecheck synth briefs style deps-batch

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
