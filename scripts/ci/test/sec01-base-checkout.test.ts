import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobs, root } from './helpers.js';

/**
 * SEC-01: the ownership and contract checks must run the checker, and read orchestration/issues.ts, from the BASE
 * commit. A PR that carries its own copy of either could widen its own ownership or switch the check off and still pass.
 */

const tsx = join(root, 'node_modules/.bin/tsx');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

const CHECKER_FILES = ['scripts/ci/check-ownership.ts', 'scripts/ci/lib.ts', 'orchestration/issues.ts', 'orchestration/ownership.ts', 'orchestration/types.ts'];

/** A clone whose base commit has the real checker and issue map, and whose head commit tampers with them and edits `changed`. */
function prClone(tamper: (dir: string) => void, changed: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sec01-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const f of CHECKER_FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(root, f), join(dir, f));
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  tamper(dir);
  mkdirSync(dirname(join(dir, changed)), { recursive: true });
  writeFileSync(join(dir, changed), 'export const x = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'head');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

const check = (script: string, pr: { dir: string; base: string; head: string }, title: string) =>
  spawnSync(tsx, [script, 'ownership'], {
    cwd: pr.dir, encoding: 'utf8',
    env: { ...process.env, BASE_SHA: pr.base, HEAD_SHA: pr.head, PR_TITLE: title, PR_LABELS: '[]', PR_AUTHOR: 'some-agent', REPO_OWNER: 'ola1145' },
  });

/** Adds paths to one lane's owns list in the PR's copy of the issue map. */
function widen(dir: string, id: string, extra: string[]) {
  const file = join(dir, 'orchestration/issues.ts');
  const text = readFileSync(file, 'utf8');
  const at = text.indexOf(`{ id: '${id}'`);
  const owns = text.indexOf('owns: [', at) + 'owns: ['.length;
  writeFileSync(file, text.slice(0, owns) + extra.map((p) => `'${p}', `).join('') + text.slice(owns));
}

describe('a PR cannot grant itself ownership (checker and issue map come from the base)', () => {
  const trusted = join(root, 'scripts/ci/check-ownership.ts');

  it('widening its own owns list in orchestration/issues.ts still fails', () => {
    const pr = prClone((d) => widen(d, 'T0', ['orchestration/issues.ts', 'services/post-call/**']), 'services/post-call/src/new.ts');
    // Control: the PR's own copy of the checker reads the PR's own map, so it waves the PR through. This is the hole.
    expect(check(join(pr.dir, 'scripts/ci/check-ownership.ts'), pr, '[1145:T0] sneaky').status).toBe(0);
    const r = check(trusted, pr, '[1145:T0] sneaky');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('services/post-call/src/new.ts');
    expect(r.stdout).toContain('orchestration/issues.ts');
  });

  it('replacing the checker with one that always passes still fails', () => {
    const pr = prClone((d) => writeFileSync(join(d, 'scripts/ci/check-ownership.ts'), 'console.log("ok");\nprocess.exit(0);\n'), 'services/post-call/src/new.ts');
    expect(check(join(pr.dir, 'scripts/ci/check-ownership.ts'), pr, '[1145:T0] sneaky').status).toBe(0);
    const r = check(trusted, pr, '[1145:T0] sneaky');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('scripts/ci/check-ownership.ts');
  });

  it('an honest change inside the lane still passes', () => {
    const pr = prClone(() => undefined, 'services/tool-api/src/handlers/take-message.ts');
    expect(check(trusted, pr, '[1145:T0] honest').status).toBe(0);
  });
});

describe('ci.yml runs the base copy of the checkers', () => {
  const ci = jobs('ci.yml');
  const trustedJobs: Array<[string, string]> = [
    ['ownership', 'check-ownership.ts ownership'],
    ['contracts-guard', 'check-ownership.ts contracts'],
  ];

  it.each(trustedJobs)('%s checks out the base commit as the workspace and the PR head under pr/', (job) => {
    const block = ci[job]!;
    expect(block, `${job}: check out github.event.pull_request.base.sha so the checker is the one already on the base branch`)
      .toMatch(/ref:\s*"?\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}"?/);
    expect(block, `${job}: the PR head goes in a subfolder (path: pr), it is only ever read by git diff`).toMatch(/path:\s*pr\b/);
    expect(block, `${job}: the PR head checkout must pin head.sha`).toMatch(/ref:\s*"?\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}"?/);
  });

  it.each(trustedJobs)('%s runs scripts/ci from the base, with the PR checkout as the working directory', (job, command) => {
    const block = ci[job]!;
    expect(block).toContain('working-directory: pr');
    expect(block, `${job}: run ../scripts/ci/${command} (base copy), not scripts/ci/${command} (PR copy)`).toContain(`../node_modules/.bin/tsx ../scripts/ci/${command}`);
    expect(block).not.toMatch(/pnpm exec tsx scripts\/ci\/check-ownership/);
  });

  it('keeps persisted git credentials out of the PR checkout', () => {
    for (const job of ['ownership', 'contracts-guard']) {
      expect(ci[job]!, `${job}: add persist-credentials: false to both checkouts`).toMatch(/persist-credentials:\s*false/);
    }
  });
});
