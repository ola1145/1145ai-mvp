# W2-22 · Eval harness in CI
**Agent:** test-engineer · **Owns:** `evals/**`, `.github/workflows/evals.yml`

Run `evals/scenarios/*.yaml` against the customer agent (text mode) and both chat agents on every change to
prompts, templates or tool schemas. Score with rule checks first (tool called, forbidden phrase absent, reply length),
LLM-judge second. A template version cannot be marked `active` unless the suite passes.
## Status
- state: TODO
