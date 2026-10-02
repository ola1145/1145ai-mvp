# W1-15 · ElevenAgents adapter (fallback engine)
**Agent:** voice-elevenlabs-builder · **Branch:** lane/voice-elevenlabs · **Depends on:** W0-01, W0-03

## Owns
`engines/elevenlabs-adapter/**`

## Tests first
- Contract tests with recorded responses from W0-03 for every method of `VoiceEngine`.
- `normalizeCallEvent` maps the captured payload to `NormalizedCallEvent`; bad signature throws.

## Steps
Fix endpoint paths/payloads from W0-03 findings; implement KB cleanup; suspended agent routing; webhook receiver
Lambda that calls `normalizeCallEvent` and publishes `call.ended` (request infra wiring via CHANGE_REQUEST).

## Acceptance
- A tenant can be switched between engines by changing `PROFILE.engine` and re-running bind (manual test in dev).

## Status
- state: IN PROGRESS (scaffold)
