import type { Issue } from './types.js';

const AGENT_LABEL: Record<Issue['agent'], string> = {
  claude: 'Claude Code subagent (isolation: worktree)',
  devin: 'Devin',
  'cursor-grok': 'Cursor background agent on Grok',
  human: 'Owner (human)',
};

/** One brief format for Linear, tasks/*.md, Devin, Cursor and Claude. Self-contained on purpose. */
export function renderBrief(i: Issue): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return `# [1145:${i.id}] ${i.title}

**Agent:** ${AGENT_LABEL[i.agent]} · **Stream:** ${i.stream} · **Priority:** P${i.priority}${i.softDeps?.length ? ` · **Soft deps:** ${i.softDeps.join(', ')}` : ''}

> Start now; nothing blocks this issue. Read \`AGENTS.md\`, then these skills: ${i.skills.map((s) => `\`.claude/skills/${s}/SKILL.md\``).join(', ')}.
> Edit only the paths under **Owns** (CI rejects anything else). Do not add dependencies or touch lockfiles.
> PR title must start with \`[1145:${i.id}]\`. Need a contract or another lane's file changed? Write
> \`contracts/CHANGE_REQUESTS/${i.id}-<n>.md\`, comment here, and keep going with a local fake.
> Anything a customer or owner reads or hears must pass the conversation-style rules: no robotic phrasing.

## Goal
${i.goal}

## Owns
${list(i.owns.map((o) => `\`${o}\``))}

## Tests first (write them, see them fail, then implement)
${list(i.testsFirst)}

## Steps
${list(i.steps)}

## Acceptance
${list(i.acceptance)}

## Run
\`${i.testCmd}\` and \`make test\` before opening the PR.
`;
}
