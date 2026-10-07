import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintWorkflow } from './workflow-lint.js';

// Usage: check-workflows.ts [workflows-dir]   (default .github/workflows in the current directory)
const dir = process.argv[2] ?? '.github/workflows';
const issues = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .flatMap((f) => lintWorkflow(join(dir, f), readFileSync(join(dir, f), 'utf8')));
for (const i of issues) console.log(`${i.file}:${i.line}: ${i.rule}: ${i.message}`);
console.log(issues.length ? `${issues.length} workflow problem(s)` : 'workflows: all actions pinned, no open bot list, no untrusted text in scripts');
process.exit(issues.length ? 1 : 0);
