# Task briefs

One brief = one lane run. A brief is a complete prompt: an agent given only `CLAUDE.md` + its brief can finish it.
Status blocks are updated by the lane agent; the orchestrator reads them at each gate.

| Wave | Brief | Agent | Parallel group |
|---|---|---|---|
| 0 | W0-01 contracts | contracts-architect | A (blocking) |
| 0 | W0-02 LiveKit/Telnyx spike | voice-livekit-builder + human | B |
| 0 | W0-03 ElevenAgents spike + grant email | voice-elevenlabs-builder + human | B |
| 0 | W0-04 long-pole accounts | human | B |
| 0 | W0-05 repo, CI, CDK bootstrap | infra-cdk | B |
| 1 | W1-10 infra | infra-cdk | C |
| 1 | W1-11 tool API | tool-api-builder | C |
| 1 | W1-12 channels | channels-builder | C |
| 1 | W1-13 provisioning | provisioning-builder | C |
| 1 | W1-14 LiveKit worker | voice-livekit-builder | C |
| 1 | W1-15 ElevenAgents adapter | voice-elevenlabs-builder | C |
| 1 | W1-16 agents | agents-builder | C |
| 1 | W1-17 post-call | postcall-builder | C |
| 1 | W1-18 integration | orchestrator + test-engineer | after C |
| 2 | W2-20 … W2-25 | see files | D |

Groups run in parallel internally; a group starts when the previous gate passes.
