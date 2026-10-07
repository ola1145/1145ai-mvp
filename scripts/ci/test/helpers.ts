import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repo root of the checkout these tests run in. */
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const read = (p: string) => readFileSync(root + p, 'utf8');

/** Top-level job ids and their blocks, without a YAML dependency (jobs are indented two spaces under `jobs:`). */
export function jobs(file: string): Record<string, string> {
  const text = read(`.github/workflows/${file}`);
  const body = text.slice(text.indexOf('\njobs:\n') + 6);
  const out: Record<string, string> = {};
  let cur = '';
  for (const line of body.split('\n')) {
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (m) { cur = m[1]!; out[cur] = ''; } else if (cur) out[cur] += line + '\n';
  }
  return out;
}

/** The workflows P3 owns. Other lanes' workflows (deploy, e2e) are checked by their own lanes. */
export const P3_WORKFLOWS = ['ci.yml', 'automerge.yml', 'ci-failure-router.yml', 'claude-review.yml', 'claude.yml'] as const;
