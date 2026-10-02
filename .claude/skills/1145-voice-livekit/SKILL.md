---
name: 1145-voice-livekit
description: Building the 1145ai voice path — Telnyx SIP into LiveKit, the single multi-tenant "frontdesk" worker (Deepgram Nova-3, Bedrock LLM, ElevenLabs Flash TTS), tenant resolution from sip.trunkPhoneNumber, tools over HTTPS, transfers, web chat text mode, and the ElevenAgents fallback adapter. Use for any work in engines/, scripts/livekit, scripts/telnyx, voice-stack.ts, or call-quality tuning.
---

# Voice path (B+, ADR-0002)

Caller → Telnyx DID → FQDN SIP connection → LiveKit SIP → dispatch rule (room per call, agent "frontdesk") →
worker on ECS Fargate (outbound connection to LiveKit; no load balancer).

## Rules
- Tenant = resolver(`sip.trunkPhoneNumber`) for calls, resolver(widget key) for web chat rooms (`chat-` prefix).
  The resolver returns a call-scoped token; it lives in `ToolsClient` only and never reaches the model.
- Module ownership: `worker.py`/`agent.py` (E5), `events.py` (E2), `call_control.py` (E3), `prompts.py`/
  `voice_config.py`/`fillers.py` (E4). Don't cross into another module; use change requests.
- Failure on the call path = take a message, never silence.
- Pin `livekit-agents` and plugins to exact versions; argument names drift between minors. Use the LiveKit docs MCP.
- Latency budget per turn: STT final ≤ 250 ms, LLM first token ≤ 500 ms, TTS first audio ≤ 150 ms, tools ≤ 300 ms.

## Useful facts
- SIP participant attributes: `sip.trunkPhoneNumber` (dialed), `sip.phoneNumber` (caller), `sip.callID`.
- Agent dispatch with `agent_name` requires the dispatch rule's room config to list the agent.
- Cold transfer: SIP REFER (`TransferSIPParticipant`); warm: `CreateSIPParticipant` on the outbound trunk into the room.
- ElevenAgents fallback: webhook tool headers use system dynamic variables (`system__agent_id`), never LLM-filled.
