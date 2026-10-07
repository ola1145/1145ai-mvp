import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '../workflow-lint.js';
import { P3_WORKFLOWS, read, root } from './helpers.js';

const SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const wf = (body: string) => `name: t\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;
const rules = (text: string) => lintWorkflow('t.yml', text).map((i) => i.rule);

describe('SEC-03: third-party actions are pinned to a commit', () => {
  it('flags a tag, a branch and a short sha', () => {
    for (const ref of ['v4', 'main', 'abc1234']) {
      expect(rules(wf(`      - uses: actions/checkout@${ref}\n`)), ref).toContain('unpinned-action');
    }
  });
  it('flags an action with no ref at all', () => {
    expect(rules(wf('      - uses: actions/checkout\n'))).toContain('unpinned-action');
  });
  it('accepts a full commit sha, with or without a version comment, quoted or not', () => {
    expect(rules(wf(`      - uses: actions/checkout@${SHA} # v6\n`))).toEqual([]);
    expect(rules(wf(`      - uses: "actions/checkout@${SHA}"\n`))).toEqual([]);
  });
  it('accepts local actions and reusable workflows in this repo', () => {
    expect(rules(wf('      - uses: ./.github/actions/thing\n'))).toEqual([]);
  });
  it('flags a reusable workflow from another repo that is not pinned, and a docker image that is not a digest', () => {
    expect(rules(wf('      - uses: some-org/repo/.github/workflows/x.yml@v1\n'))).toContain('unpinned-action');
    expect(rules(wf('      - uses: docker://alpine:3.20\n'))).toContain('unpinned-action');
    expect(rules(wf(`      - uses: docker://alpine@sha256:${'a'.repeat(64)}\n`))).toEqual([]);
  });
  it('says which line and what to do in one line', () => {
    const [i] = lintWorkflow('.github/workflows/x.yml', wf('      - uses: actions/checkout@v6\n'));
    expect(i!.line).toBe(9);
    expect(i!.message).toMatch(/git ls-remote/);
    expect(i!.message).not.toContain('\n');
  });
});

describe('SEC-02: agent workflows only trust named bots', () => {
  it('flags allowed_bots "*" in any quoting', () => {
    for (const v of ['"*"', "'*'", '*']) {
      expect(rules(wf(`      - uses: anthropics/claude-code-action@${SHA}\n        with:\n          allowed_bots: ${v}\n`)), v).toContain('allow-all-bots');
    }
  });
  it('accepts a named list', () => {
    expect(rules(wf(`      - uses: anthropics/claude-code-action@${SHA}\n        with:\n          allowed_bots: "claude[bot],cursor[bot]"\n`))).toEqual([]);
  });
});

describe('untrusted event text never reaches a shell or a prompt as text', () => {
  it('flags a PR title or body inside a run block', () => {
    expect(rules(wf('      - run: |\n          echo "${{ github.event.pull_request.title }}"\n'))).toContain('untrusted-expression');
    expect(rules(wf('      - run: echo ${{ github.event.pull_request.body }}\n'))).toContain('untrusted-expression');
  });
  it('flags comment bodies, branch names and commit messages in run blocks', () => {
    for (const e of ['github.event.comment.body', 'github.head_ref', 'github.event.workflow_run.head_branch', 'github.event.head_commit.message', 'github.event.issue.title']) {
      expect(rules(wf(`      - run: |\n          echo "\${{ ${e} }}"\n`)), e).toContain('untrusted-expression');
    }
  });
  it('flags a PR title inside an action prompt', () => {
    expect(rules(wf(`      - uses: anthropics/claude-code-action@${SHA}\n        with:\n          prompt: |\n            PR TITLE: \${{ github.event.pull_request.title }}\n`))).toContain('untrusted-expression');
  });
  it('accepts the same expressions in env, which is how they should be passed', () => {
    expect(rules(wf('      - env:\n          TITLE: ${{ github.event.pull_request.title }}\n          BODY: ${{ github.event.pull_request.body }}\n        run: |\n          printf %s "$TITLE" > t.txt\n'))).toEqual([]);
  });
  it('accepts them in an if condition, where no shell or prompt sees the text', () => {
    expect(rules(wf("      - if: contains(github.event.comment.body, '@claude')\n        run: echo hi\n"))).toEqual([]);
  });
  it('knows where a block ends: the next key is not part of the run script', () => {
    expect(rules(wf('      - run: |\n          echo hi\n        env:\n          T: ${{ github.event.pull_request.title }}\n'))).toEqual([]);
  });
});

describe('least privilege', () => {
  it('flags a workflow with no top-level permissions block', () => {
    expect(rules('name: t\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n')).toContain('missing-permissions');
  });
});

describe('the workflows in this repo', () => {
  it.each(P3_WORKFLOWS)('%s passes the lint', (file) => {
    const issues = lintWorkflow(`.github/workflows/${file}`, read(`.github/workflows/${file}`));
    expect(issues.map((i) => `${i.file}:${i.line}: ${i.rule}: ${i.message}`)).toEqual([]);
  });

  const hasPyYaml = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!hasPyYaml)('every workflow file is valid YAML with on: and jobs: (a typo here would stop all CI)', () => {
    const script = 'import sys,yaml\nfor f in sys.argv[1:]:\n  d=yaml.safe_load(open(f))\n  assert isinstance(d,dict) and "jobs" in d and (True in d or "on" in d), f\n';
    const files = readdirSync(`${root}.github/workflows`).filter((f) => f.endsWith('.yml')).map((f) => `${root}.github/workflows/${f}`);
    const r = spawnSync('python3', ['-c', script, ...files], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
