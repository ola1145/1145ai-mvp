# Eval scenarios

Each YAML file in `scenarios/` is a scripted conversation with rule checks. Rules are deterministic (tool called /
not called, phrase present / absent, reply length, `checkReply` on every agent turn). An LLM judge scores only tone
(warmth and brevity, 1 to 5); the gate is an average of 4 or more, and a high score never rescues a rule failure.
A template version cannot be activated unless every scenario passes 5/5 runs (W2-22).

## Run

    pnpm vitest run packages/conversation-style evals     # unit tests plus every scenario against the fakes
    pnpm exec tsx evals/src/cli.ts --runs 5               # the same suite as a CLI, exit code 1 on any failure
    pnpm exec tsx evals/src/cli.ts --only skeptical-wants-human

## What the runner checks

For every agent turn, including the greeting:

- `checkReply` from `@1145/conversation-style`. Any error fails, and naturalness must be 85 or more.
- Voice greetings must carry the AI and recording disclosure (`requireDisclosure`).
- The turn's `expect` block: `tools_called`, `tools_not_called`, `reply_contains`, `reply_contains_any`,
  `reply_not_contains`, `reply_max_chars`, `reply_max_words`, `reply_asks_for_verification` (a keyword heuristic).
  Unknown keys are an error so a typo cannot turn a check off.
- `rules.first_utterance_contains` against the greeting.
- The judge average per scenario and across the suite. A judge that errors fails the scenario.

## Scenario format

```yaml
agent: customer            # customer | onboarding | admin
channel: voice             # voice | webchat | telegram
tenant_fixture: barber-frisco
caller_id: "+12145550123"  # optional, resolved by the real resolver path, never from text
tags: [skeptical]          # the suite requires 3+ of each category listed in test/scenarios.test.ts
greeting: "Hi, this is Ava ..."   # voice: the agent's opening line (scripted for the fakes)
turns:
  - caller: "..."          # or owner: "..."
    interrupts: true       # optional, the person talks over the agent
    fake: { reply: "...", tools: [check_availability] }   # reference reply replayed by the fake adapter
    expect: { tools_called: [check_availability], reply_max_words: 25 }
rules:
  first_utterance_contains: ["AI", "recorded"]
```

## Fakes and live agents

CI runs against `fakeAdapter`, which replays each turn's `fake` reply. That keeps CI free and deterministic, and
it tests the checker, the runner and the scenario expectations. The `fake` lines are the reference answers: when you
change a prompt or template, update them to what the agent should say, and they must pass the same gates.

A live adapter implements `AgentAdapter` (`src/adapters.ts`) and is passed to `runSuite`. Likewise the real judge is
`new LlmJudge(complete)` with a Bedrock-backed `complete`; tests inject fakes and never call a paid API.
Both live pieces are wired by the owning lane's job, see `contracts/CHANGE_REQUESTS/A4-1.md`.
