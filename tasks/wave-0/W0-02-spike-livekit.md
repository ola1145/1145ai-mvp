# W0-02 · Spike: one real call on B+ (Telnyx → LiveKit → frontdesk)
**Agent:** voice-livekit-builder (code) + you (phone, accounts) · **Branch:** lane/spike-livekit

## Goal
Evidence for ADR-0002. Follow `docs/runbooks/spike-livekit-telnyx-call.md`.

## Owns
`engines/livekit-agent/**`, `docs/runbooks/spike-livekit-telnyx-call.md` (results section only)

## Steps
1. Pin `livekit-agents` and plugins to exact versions; fix any argument-name drift in `frontdesk/worker.py`.
2. Add a tiny local stub tool server (`engines/livekit-agent/dev/stub_tools.py`) returning fixed slots and a booking.
3. Run with `RESOLVER_MODE=static` and `STATIC_TENANT_JSON` for a fixture tenant.
4. You place the calls. The agent records metrics from LiveKit's metrics events into the Status block.

## Acceptance (record numbers, do not just tick)
- `sip.trunkPhoneNumber` == dialed DID; caller ID captured
- p50 / p95 turn latency over ≥10 turns; ElevenLabs Flash TTS used
- Cold transfer (SIP REFER) works; warm transfer attempt documented
- 5 concurrent calls handled
- If Telnyx-hosted LiveKit fails: repeat on LiveKit Cloud + Telnyx SIP trunk and record which path passed

## Status
- state: TODO
- path used: 
- latency p50/p95: 
- notes: 
