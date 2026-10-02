# Spike W0-02: one real call through Telnyx → LiveKit → frontdesk agent

**Goal:** prove the B+ path with evidence before Wave 1 commits to it.

1. Telnyx: buy one US local number (by hand). Create an FQDN SIP connection pointing at your LiveKit SIP URI
   (Telnyx-hosted LiveKit per the Telnyx docs; or LiveKit Cloud project SIP URI). Assign the number to it.
2. LiveKit: create one inbound trunk (accept the number, or all numbers on the connection) and one dispatch rule:
   individual room per call, `room_config.agents = [{agent_name: "frontdesk"}]`.
3. Run the worker locally: `cd engines/livekit-agent && uv run python -m frontdesk.worker dev` with
   `RESOLVER_MODE=static` and a fixture tenant.
4. Call the number from your phone. Ask for an appointment tomorrow at 3 pm.

**Record in `tasks/wave-0/W0-02-spike-livekit.md` Status:**
- [ ] `sip.trunkPhoneNumber` equals the dialed DID; `sip.phoneNumber` equals your caller ID
- [ ] Disclosure line plays first
- [ ] Tool call reached the stub tool server with the static tenant token
- [ ] Turn latency p50 / p95 over 10 turns (LiveKit metrics), and by ear vs the ElevenAgents spike
- [ ] Transfer test: agent dials a second phone into the room (warm) and SIP REFER (cold)
- [ ] Hangup event received; call ID ↔ room name ↔ tenant correlated in logs
- [ ] Concurrency: 5 simultaneous calls from a SIP load tool or friends
