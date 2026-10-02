---
description: Security review of a lane branch before merge
argument-hint: <branch, e.g. lane/tool-api>
---
Launch the `security-reviewer` subagent on branch `$ARGUMENTS` with `git diff main...$ARGUMENTS`.
Then run `make test` on that branch's worktree if it exists. Report the reviewer's verdict and the test result.
Do not merge; I merge.
