# ADR-0002: MVP voice engine = LiveKit on Telnyx with ElevenLabs TTS ("B+")

**Status:** Proposed — confirm at Gate 1 with spike results · **Date:** 2026-10-02

## Context
Stated requirements: SIP is a must; automated number purchase via provider API; live streaming transcript and
owner join/transfer in the dashboard; Deepgram Nova-3. The ElevenLabs grant's coverage of agent minutes and paid
multi-tenant use is unconfirmed. WhatsApp is preferred through Telnyx/Twilio, which ElevenAgents cannot import.

## Options considered
| Dimension | A · ElevenAgents | B · LiveKit on Telnyx | B+ · B with ElevenLabs TTS |
|---|---|---|---|
| Code for voice agent | Lowest (config) | Medium (one worker) | Medium |
| Live transcript, owner joins room | No (post-call; phone transfer) | Yes | Yes |
| Voice quality | ElevenLabs | Telnyx/other TTS | ElevenLabs |
| Grant usable | Only if it covers agent minutes | No | Yes, on TTS characters (confirm commercial use) |
| Capacity | 30 shared concurrent (Scale) | Unpublished; test | Unpublished; test |
| Per-minute cost | ≈$0.10 all-in | Lower | Lower; TTS on grant initially |
| One brain for voice + web chat | No | Yes (LiveKit text mode) | Yes |

## Decision
B+ is the default. The ElevenAgents adapter is built thin in Wave 1 as a fallback and for voice A/B tests.
If the Telnyx-hosted LiveKit spike fails, use LiveKit Cloud with a Telnyx SIP trunk; agent code is unchanged.

## Consequences
- We own the voice loop: latency tuning, interruption handling, and eval are our job.
- The dashboard can stream transcripts and support owner barge-in later without changing engines.
- Revisit if the spike's p95 turn latency exceeds 1.5 s after tuning, or if the grant answer is an unconditional yes
  for agent minutes and the live-room features slip to Phase 2.
