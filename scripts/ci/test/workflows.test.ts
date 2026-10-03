import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

/** Top-level job ids and their blocks, without a YAML dependency (jobs are indented two spaces under `jobs:`). */
function jobs(file: string): Record<string, string> {
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

describe('required checks keep their names', () => {
  const required = (JSON.parse(read('.github/rulesets/main.json')) as { rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }> })
    .rules.find((r) => r.type === 'required_status_checks')!.parameters!.required_status_checks!.map((c) => c.context);
  const defined = [...Object.keys(jobs('ci.yml')), ...Object.keys(jobs('claude-review.yml'))];
  it.each(required)('%s is produced by a workflow job', (name) => {
    expect(defined, `ruleset requires "${name}" but no job has that id; renaming a job would block every PR`).toContain(name);
  });
});

describe('ci.yml is fast and bounded', () => {
  const ci = jobs('ci.yml');
  it.each(Object.keys(ci))('%s has a timeout of 8 minutes or less', (name) => {
    const m = /timeout-minutes:\s*(\d+)/.exec(ci[name]!);
    expect(m, `${name} needs timeout-minutes so a hung job fails in under 8 minutes`).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(8);
  });
  it('installs with a frozen lockfile and runs Python against the locked environment', () => {
    const text = read('.github/workflows/ci.yml');
    expect(text).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
    expect(text).not.toMatch(/uv run pytest/);
  });
  it('lets main runs finish so main-green gets a verdict', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(/cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/);
  });
});

describe('agent-facing workflows are safe on a public repo', () => {
  it('claude.yml only wakes for people with write access', () => {
    expect(read('.github/workflows/claude.yml')).toMatch(/author_association/);
  });
  it('the failure router quotes logs only through the sanitizer and routes with route-agent.sh', () => {
    const t = read('.github/workflows/ci-failure-router.yml');
    expect(t).toContain('scripts/ci/sanitize-log.sh');
    expect(t).toContain('scripts/ci/route-agent.sh');
  });
  it('claude-review clears any committed verdict file before the review runs', () => {
    const t = read('.github/workflows/claude-review.yml');
    expect(t.indexOf('rm -f review-verdict.txt')).toBeGreaterThan(-1);
    expect(t.indexOf('rm -f review-verdict.txt')).toBeLessThan(t.indexOf('claude-code-action'));
  });
  it('claude-review reads the verdict from the reviewer comment, not from a file the model must write', () => {
    const t = read('.github/workflows/claude-review.yml');
    expect(t).toContain('scripts/ci/review-verdict.sh');
    expect(t).toContain('REVIEW_START');
    expect(t).toContain('Merge gate: APPROVE');
    expect(t, 'a redirect in allowedTools never matches, which is how the gate failed with "no verdict written"').not.toMatch(/allowedTools[^\n]*echo/);
    expect(t).not.toMatch(/test -f review-verdict\.txt/);
  });
  it('claude-review blocks only on checklist violations', () => {
    const t = read('.github/workflows/claude-review.yml');
    expect(t).toMatch(/BLOCK only for a concrete violation/);
    expect(t).toMatch(/Do NOT block for/);
  });
});
