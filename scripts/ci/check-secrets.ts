import { execFileSync } from 'node:child_process';
import { parseAddedLines, scanAddedLines } from './secrets.js';

// Run with the PR checkout as the working directory, from the base checkout's copy of this script (see ci.yml).
const { BASE_SHA, HEAD_SHA } = process.env;
if (!BASE_SHA || !HEAD_SHA) { console.error('check-secrets: set BASE_SHA and HEAD_SHA'); process.exit(2); }
const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=AM', `${BASE_SHA}...${HEAD_SHA}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const findings = scanAddedLines(parseAddedLines(diff));
for (const f of findings) console.log(f.message);
console.log(findings.length ? `${findings.length} possible secret(s) in the lines this PR adds` : 'no secret-looking literals in the lines this PR adds');
process.exit(findings.length ? 1 : 0);
