.PHONY: bootstrap test test-ts test-py typecheck synth

bootstrap:
	pnpm install
	cd engines/livekit-agent && uv sync
	cd agents && uv sync

test: test-ts test-py

test-ts:
	pnpm vitest run

test-py:
	cd engines/livekit-agent && uv run pytest -q
	cd agents && uv run pytest -q

typecheck:
	pnpm tsc -p tsconfig.json --noEmit
	cd infra/cdk && pnpm tsc -p tsconfig.json

synth:
	cd infra/cdk && pnpm cdk synth -q
