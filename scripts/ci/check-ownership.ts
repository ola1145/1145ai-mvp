import { execFileSync } from 'node:child_process';
import { contractGuard, ownershipViolations } from './lib.js';

const mode = process.argv[2] ?? 'ownership';
// --no-renames: a rename must show both the old and the new path, otherwise moving a file out of another lane's
// directory would look like it only touched the destination.
const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`], { encoding: 'utf8' })
  .split('\n').filter(Boolean);
const pr = {
  title: process.env.PR_TITLE ?? '', labels: JSON.parse(process.env.PR_LABELS ?? '[]') as string[],
  author: process.env.PR_AUTHOR ?? '', repoOwner: process.env.REPO_OWNER ?? '', changed,
};
const r = mode === 'contracts' ? contractGuard(pr) : ownershipViolations(pr);
console.log(r.message);
process.exit(r.ok ? 0 : 1);
