---
description: Check a gate's exit criteria and report pass/fail per item
argument-hint: <gate number: 1 | 2 | 3>
---
Gate criteria live in `docs/03-implementation-plan.md` (Gates 1–2) and `docs/runbooks/launch-checklist.md` (Gate 3).
For gate $ARGUMENTS: run `make test` and `make synth`, read the Status blocks of the relevant briefs, and check each
criterion. Output a table: criterion · PASS/FAIL/NEEDS HUMAN · evidence. Never mark a human-only item as PASS.
