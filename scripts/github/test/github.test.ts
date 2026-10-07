import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('CODEOWNERS (SEC-01): the files that decide who may merge what need the owner', () => {
  const lines = read('.github/CODEOWNERS').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const entries = lines.map((l) => { const [path, ...owners] = l.split(/\s+/); return { path: path!, owners }; });
  const has = (path: string) => entries.find((e) => e.path === path);

  it.each([
    ['/scripts/ci/', 'the checkers; a PR that edits them must not be the one judging itself'],
    ['/orchestration/issues.ts', 'the issue to owned-paths map the ownership check reads'],
    ['/orchestration/ownership.ts', 'the path matcher the ownership check uses'],
    ['/.github/', 'workflows, rulesets and CODEOWNERS itself'],
    ['/contracts/', 'frozen contracts'],
    ['/packages/shared/', 'shared types'],
    ['/infra/cdk/lib/data-stack.ts', 'tenant data isolation'],
    ['/infra/cdk/lib/github-oidc-stack.ts', 'who may deploy'],
  ])('%s has an owner (%s)', (path) => {
    const e = has(path);
    expect(e, `add "${path}  @ola1145" to .github/CODEOWNERS`).toBeDefined();
    expect(e!.owners.length).toBeGreaterThan(0);
    for (const o of e!.owners) expect(o).toMatch(/^@[\w-]+(\/[\w-]+)?$/);
  });

  it('only names paths that exist, so a rename cannot silently drop a protection', () => {
    for (const { path } of entries) expect(existsSync(join(root, path.replace(/^\//, ''))), `${path} in CODEOWNERS does not exist`).toBe(true);
  });

  it('is not shadowed: a later broader pattern would win over an earlier specific one', () => {
    entries.forEach((e, i) => {
      for (const later of entries.slice(i + 1)) {
        if (later.path.endsWith('/') && e.path.startsWith(later.path) && e.path !== later.path) {
          expect(later.owners, `${later.path} comes after ${e.path} and would replace its owners`).toEqual(e.owners);
        }
      }
    });
  });
});

describe('the main ruleset', () => {
  const rules = (JSON.parse(read('.github/rulesets/main.json')) as { rules: Array<{ type: string; parameters?: Record<string, unknown> }> }).rules;
  it('requires code owner review, which is what makes CODEOWNERS bind', () => {
    expect(rules.find((r) => r.type === 'pull_request')!.parameters!.require_code_owner_review).toBe(true);
  });
  it('requires the evals check (A4-1)', () => {
    const checks = (rules.find((r) => r.type === 'required_status_checks')!.parameters!.required_status_checks as Array<{ context: string }>).map((c) => c.context);
    expect(checks).toContain('evals');
  });
});

// ---- setup.sh and verify.sh against a fake gh ----------------------------------------------------------------------
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** A `gh` that logs every call (and any stdin body) and answers from `pattern<TAB>output` lines, first match wins. */
function fakeGh(answers: Array<[string, string]>) {
  const dir = mkdtempSync(join(tmpdir(), 'fakegh-'));
  const log = join(dir, 'calls.log');
  const table = join(dir, 'answers.tsv');
  writeFileSync(log, '');
  writeFileSync(table, answers.map(([p, o]) => `${p}\t${o}`).join('\n') + '\n');
  writeFileSync(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    'printf "gh %s\\n" "$*" >> "$FAKE_GH_LOG"',
    'if [[ " $* " == *" --input - "* ]]; then printf "  body: " >> "$FAKE_GH_LOG"; cat | tr -d "\\n" >> "$FAKE_GH_LOG"; printf "\\n" >> "$FAKE_GH_LOG"; fi',
    'while IFS=$\'\\t\' read -r pat out; do',
    '  [ -z "$pat" ] && continue',
    '  if [[ "$*" == *"$pat"* ]]; then printf "%b\\n" "$out"; exit 0; fi',
    'done < "$FAKE_GH_ANSWERS"',
    'exit 0',
  ].join('\n') + '\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (script: string) => {
    const r = spawnSync('bash', [join(root, 'scripts/github', script), 'o/r'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ANSWERS: table },
    });
    return { code: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8') };
  };
  return { run };
}

const requiredChecks = () => (JSON.parse(read('.github/rulesets/main.json')) as { rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }> })
  .rules.find((r) => r.type === 'required_status_checks')!.parameters!.required_status_checks!.map((c) => c.context).sort().join('\\n');

describe.skipIf(!hasJq)('setup.sh restricts both environments to main (SEC-34)', () => {
  const base: Array<[string, string]> = [['api user', '4242']];

  it.each(['dev', 'prod'])('creates the %s environment with custom branch policies, then allows only main', (env) => {
    const { run } = fakeGh(base);
    const r = run('setup.sh');
    expect(r.code, r.out).toBe(0);
    const put = r.calls.split('\n').findIndex((l) => l.includes(`-X PUT repos/o/r/environments/${env} `));
    expect(put, `setup.sh must PUT environments/${env} with a body`).toBeGreaterThan(-1);
    const body = r.calls.split('\n')[put + 1]!;
    expect(body).toMatch(/"custom_branch_policies":\s*true/);
    expect(body).toMatch(/"protected_branches":\s*false/);
    expect(r.calls).toMatch(new RegExp(`-X POST repos/o/r/environments/${env}/deployment-branch-policies .*name=main`));
  });

  it('keeps the owner as the required reviewer on prod, and not on dev', () => {
    const { run } = fakeGh(base);
    const lines = run('setup.sh').calls.split('\n');
    const prodBody = lines[lines.findIndex((l) => l.includes('environments/prod ')) + 1]!;
    const devBody = lines[lines.findIndex((l) => l.includes('environments/dev ')) + 1]!;
    expect(prodBody).toMatch(/"reviewers":\s*\[\s*\{\s*"type":\s*"User",\s*"id":\s*4242/);
    expect(devBody).not.toContain('reviewers');
  });

  it('is idempotent: no second main policy when it is already there', () => {
    const { run } = fakeGh([
      ['api user', '4242'],
      ['environments/dev/deployment-branch-policies --jq .branch_policies[].name', 'main'],
      ['environments/prod/deployment-branch-policies --jq .branch_policies[].name', 'main'],
    ]);
    const r = run('setup.sh');
    expect(r.code, r.out).toBe(0);
    expect(r.calls).not.toMatch(/-X POST repos\/o\/r\/environments\/(dev|prod)\/deployment-branch-policies/);
    expect(r.calls).not.toMatch(/-X DELETE/);
  });

  it('deletes a branch policy that is not main', () => {
    const { run } = fakeGh([
      ['api user', '4242'],
      ['environments/prod/deployment-branch-policies --jq .branch_policies[]|select(.name!="main")|.id', '77'],
      ['environments/prod/deployment-branch-policies --jq .branch_policies[].name', 'main\\nrelease/*'],
    ]);
    const r = run('setup.sh');
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain('-X DELETE repos/o/r/environments/prod/deployment-branch-policies/77');
  });
});

describe.skipIf(!hasJq)('verify.sh', () => {
  const healthy = (): Array<[string, string]> => [
    ['.allow_auto_merge', 'true'],
    ['.delete_branch_on_merge', 'true'],
    ['.allow_squash_merge', 'true,false,false'],
    ['select(.name=="main-protection")', '7'],
    ['select(.type=="required_status_checks")', requiredChecks()],
    ['require_code_owner_review', 'true'],
    ['protection_rules', 'true'],
    ['environments/dev --jq .deployment_branch_policy', 'true'],
    ['environments/prod --jq .deployment_branch_policy', 'true'],
    ['environments/dev/deployment-branch-policies', 'main'],
    ['environments/prod/deployment-branch-policies', 'main'],
    ['secret list', 'CLAUDE_CODE_OAUTH_TOKEN\\nAUTOMERGE_PAT'],
  ];

  it('passes on a repo set up the way setup.sh leaves it', () => {
    const r = fakeGh(healthy()).run('verify.sh');
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });

  it.each([
    ['dev', 'environments/dev --jq .deployment_branch_policy', 'false', 'dev deploys only from main'],
    ['prod', 'environments/prod --jq .deployment_branch_policy', 'false', 'prod deploys only from main'],
    ['dev', 'environments/dev/deployment-branch-policies', 'main,feature', 'dev branch policies'],
    ['prod', 'environments/prod/deployment-branch-policies', 'release', 'prod branch policies'],
  ])('fails when %s is not limited to main, and says which one', (_env, pattern, answer, label) => {
    const r = fakeGh([[pattern, answer], ...healthy()]).run('verify.sh');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL ${label}`);
  });

  it('fails when code owner review is not enforced on the live ruleset', () => {
    const r = fakeGh([['require_code_owner_review', 'false'], ...healthy()]).run('verify.sh');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL code owner review required');
  });
});

describe('scripts parse', () => {
  it.each(['setup.sh', 'verify.sh'])('%s', (s) => {
    expect(spawnSync('bash', ['-n', join(root, 'scripts/github', s)]).status).toBe(0);
  });
});
