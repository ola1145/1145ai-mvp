import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { renderBrief } from './brief.js';
import { ISSUES } from './issues.js';

rmSync('tasks', { recursive: true, force: true });
mkdirSync('tasks', { recursive: true });
for (const i of ISSUES) writeFileSync(`tasks/${i.id}.md`, `<!-- generated from orchestration/issues.ts; do not edit -->\n${renderBrief(i)}`);
const rows = ISSUES.map((i) => `| [${i.id}](${i.id}.md) | ${i.title} | ${i.agent} | ${i.stream} | P${i.priority} |`).join('\n');
writeFileSync('tasks/README.md', `<!-- generated -->\n# Issues (${ISSUES.length})\n\n| ID | Title | Agent | Stream | Priority |\n|---|---|---|---|---|\n${rows}\n`);
console.log(`rendered ${ISSUES.length} briefs`);
