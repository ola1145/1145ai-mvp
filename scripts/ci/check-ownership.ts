import { execSync } from 'node:child_process';
import { contractGuard, ownershipViolations } from './lib.js';

const mode = process.argv[2] ?? 'ownership';
const changed = execSync(`git diff --name-only ${process.env.BASE_SHA}...${process.env.HEAD_SHA}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
const pr = {
  title: process.env.PR_TITLE ?? '', labels: JSON.parse(process.env.PR_LABELS ?? '[]') as string[],
  author: process.env.PR_AUTHOR ?? '', repoOwner: process.env.REPO_OWNER ?? '', changed,
};
const r = mode === 'contracts' ? contractGuard(pr) : ownershipViolations(pr);
console.log(r.message);
process.exit(r.ok ? 0 : 1);
