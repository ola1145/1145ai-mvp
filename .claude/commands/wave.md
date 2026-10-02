---
description: Dispatch every open brief in a wave to its subagent, in parallel
argument-hint: <wave number: 0 | 1 | 2>
---
1. Read `tasks/README.md` and every brief in `tasks/wave-$ARGUMENTS/`.
2. Skip briefs owned by a human and briefs whose Status says `state: DONE`.
3. For each remaining brief, launch the subagent named in its header with the Task tool, all in parallel. Prompt each:
   "Read CLAUDE.md and <brief path>. Work only in the paths under Owns. Follow the working loop. Report state, tests run, blockers, and any CHANGE_REQUESTS you filed."
4. Do not edit code yourself. When all subagents return, print a table: brief · state · tests · blockers.
5. If any CHANGE_REQUESTS were filed, list them and stop for my decision before re-dispatching.
