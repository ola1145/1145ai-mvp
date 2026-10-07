# Eval scenarios

Each YAML file in `scenarios/` is a scripted conversation with rule checks. Rules are deterministic (tool called /
not called, phrase present / absent, reply length, `checkReply` on every agent turn). An LLM judge scores only tone
(warmth and brevity, 1 to 5); the gate is an average of 4 or more, and a high score never rescues a rule failure.
A template version cannot be activated unless every scenario passes 5/5 runs (W2-22).

## Run

    pnpm vitest run packages/conversation-style evals     # unit tests plus every scenario against the fakes
    make evals                                            # the same suite as a CLI, 5 runs, exit code 1 on any failure
    pnpm exec tsx evals/src/cli.ts --only skeptical-wants-human

Both are offline, free and deterministic. A live run against the real agents is opt-in, see below.

## What the runner checks

For every agent turn, including the greeting:

- `checkReply` from `@1145/conversation-style`. Any error fails, and naturalness must be 85 or more.
- Voice greetings must carry the AI and recording disclosure (`requireDisclosure`).
- The turn's `expect` block. Unknown keys are an error so a typo cannot turn a check off.
  - `tools_called` (each must be called; an explicit `[]` means no tool at all), `tools_not_called`. Names must be
    tools the agent really has (`src/tools.ts`, kept in step with the agents' code); `propose_*` globs are allowed.
  - `reply_contains`, `reply_contains_any`, `reply_not_contains`, `reply_max_chars`, `reply_max_words`.
  - `first_sentence_contains_any`: the answer comes first (copilot: "Three tomorrow, first one's Ada at 9.").
  - `api_paths_not_contains`: no API path the tools hit this turn contains the string (e.g. another onboarding id).
    Fails if the adapter does not report paths.
  - `reply_asks_for_verification` (a keyword heuristic).
- `rules.first_utterance_contains` against the greeting.
- `rules.max_owner_messages_to_complete` (onboarding): setup must finish, meaning `name_agent` and
  `provisioning_status` have both run, within that many owner messages.
- Suite gates: the judge average (>= 4), and the median owner messages to finish onboarding (< 12, A2 acceptance)
  over every scenario with a budget. A flow that never finishes counts as infinite.

## Scenario format

```yaml
agent: customer            # customer | onboarding | admin
channel: voice             # voice | webchat | telegram
tenant_fixture: barber-frisco
caller_id: "+12145550123"  # optional, resolved by the real resolver path, never from text
tags: [skeptical]          # the suite requires 3+ of each category, and one per Gate moment (gate-*), see test/scenarios.test.ts
greeting: "Hi, this is Ava ..."   # voice: the agent's opening line (scripted for the fakes)
api:                       # optional: what the agent's tools get back in a live run, keyed "<METHOD> <path suffix>"
  "POST /v1/tools/availability": { error: unavailable, status: 503 }
turns:
  - caller: "..."          # or owner: "..."
    interrupts: true       # optional, the person talks over the agent
    fake: { reply: "...", tools: [check_availability] }   # reference reply replayed by the fake adapter (+ api_paths)
    expect: { tools_called: [check_availability], reply_max_words: 25 }
rules:
  first_utterance_contains: ["AI", "recorded"]
```

## Fakes and live agents

CI runs against `fakeAdapter`, which replays each turn's `fake` reply, and the offline `heuristicJudge`. That keeps CI
free and deterministic, and it tests the checker, the runner and the scenario expectations. The `fake` lines are the
reference answers: when you change a prompt or template, update them to what the agent should say, and they must pass
the same gates. The `api` fixture is what a live adapter serves from a fake tool API, so the real model sees the data
the reference answer assumes.

A live run is opt-in and only for the nightly job:

    EVALS_LIVE=1 EVALS_LIVE_MODULE=path/to/live.ts pnpm exec tsx evals/src/cli.ts --runs 5

The module exports `createLive()` returning `{ adapter, judge? }`: an `AgentAdapter` (`src/adapters.ts`) driving the
LiveKit text session or the AgentCore agents, and `new LlmJudge(complete)` with a Bedrock-backed `complete`.
Without `EVALS_LIVE=1` the module is ignored; with it, a missing or broken module exits 2 instead of quietly running
the fakes. Tests inject fakes and never call a paid API. Wiring: `contracts/CHANGE_REQUESTS/A4-1.md` and `A4-2.md`.
