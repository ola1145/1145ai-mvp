# W0-03 · Spike: ElevenAgents fallback + grant question
**Agent:** voice-elevenlabs-builder + you · **Branch:** lane/spike-elevenlabs

## Goal
Keep Option A a live fallback with evidence, and get the grant answer in writing.

## Steps
1. You send the grant email (draft in `docs/runbooks/elevenlabs-grant-email.md`, write it first). Ask:
   (a) does the grant cover Agents minutes or only TTS characters; (b) may a commercial multi-tenant product use it;
   (c) what happens to live agents and numbers when the grant ends.
2. Configure a template agent by hand with two webhook tools pointing at a request bin; headers per
   `engines/elevenlabs-adapter/src/index.ts` (system__agent_id, system__conversation_id).
3. Import one Telnyx number over SIP trunk; call it; capture the post-call webhook body and signature header.
4. Verify every endpoint path in the adapter against the live API reference; list differences in Status.

## Acceptance
- Captured webhook verifies with `verifyElevenLabsSignature`
- Tool call headers carry system-populated agent id (not LLM-filled)
- Grant email sent; response (when it arrives) pasted into Status
- By-ear voice comparison vs W0-02 recorded

## Status
- state: TODO
