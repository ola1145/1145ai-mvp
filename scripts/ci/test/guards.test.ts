import { describe, expect, it } from 'vitest';
import { contractGuard, ownershipViolations, parseDepRequests, prTag, renderDepBatch, unparsedDepRequests } from '../lib.js';

const pr = (title: string, changed: string[], labels: string[] = [], author = 'devin-ai-integration[bot]') => ({ title, changed, labels, author, repoOwner: 'ola1145' });

describe('ownership edge cases', () => {
  it('points dependency and lockfile edits at P3 instead of a generic refusal', () => {
    const r = ownershipViolations(pr('[1145:C3] x', ['pnpm-lock.yaml']));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lockfile|dependenc/i);
    expect(r.message).toContain('Kind: dependency');
  });
  it('does not add the dependency hint to ordinary violations', () => {
    expect(ownershipViolations(pr('[1145:C3] x', ['services/tool-api/src/a.ts'])).message).not.toContain('Kind: dependency');
  });
  it('parses tags strictly', () => {
    expect(prTag('[1145:T1]reschedule')).toBe('T1');
    expect(prTag('  [1145:P12] spaced')).toBe('P12');
    expect(prTag('[1145:t1] lowercase')).toBeUndefined();
    expect(prTag('Revert "[1145:T1] x"')).toBeUndefined();
  });
  it('does not treat a lookalike path as owned', () => {
    expect(ownershipViolations(pr('[1145:P3] x', ['scripts/ci-evil/x.ts'])).ok).toBe(false);
    expect(ownershipViolations(pr('[1145:P3] x', ['scripts/ci/x.ts'])).ok).toBe(true);
  });
  it('a deleted file outside ownership still counts as a change', () => {
    expect(ownershipViolations(pr('[1145:P3] x', ['packages/shared/src/old.ts', 'scripts/ci/new.ts'])).ok).toBe(false);
  });
});

describe('contract guard edge cases', () => {
  it('names every offending file and the label to add, and only those files', () => {
    const r = contractGuard({ labels: ['agent:claude'], changed: ['contracts/events/a.json', 'packages/shared/src/b.ts', 'services/x/a.ts'] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('contracts/events/a.json');
    expect(r.message).toContain('packages/shared/src/b.ts');
    expect(r.message).not.toContain('services/x/a.ts');
    expect(r.message).toContain('contract-change');
  });
});

describe('dependency request batching', () => {
  const files = [
    { path: 'contracts/CHANGE_REQUESTS/T2-1.md', text: '# Need a dep\nKind: dependency\n- npm: `zod@^3.23.0` in services/tool-api\n- uv: `httpx>=0.27` in engines/livekit-agent\n' },
    { path: 'contracts/CHANGE_REQUESTS/T3-1.md', text: '# Contract tweak\nKind: contract\nAdd a field.\n' },
    { path: 'contracts/CHANGE_REQUESTS/A1-2.md', text: 'Kind: dependency\n- npm: `zod@^3.23.0` in agents/admin\n- npm: `ulid@2.3.0` in services/tool-api\n' },
  ];
  it('collects only dependency requests and groups them by package', () => {
    const batch = parseDepRequests(files);
    expect(batch.map((b) => b.name).sort()).toEqual(['httpx', 'ulid', 'zod']);
    const zod = batch.find((b) => b.name === 'zod')!;
    expect(zod.ecosystem).toBe('npm');
    expect(zod.requests.map((r) => r.from).sort()).toEqual(['A1-2', 'T2-1']);
    expect(zod.requests.map((r) => r.where).sort()).toEqual(['agents/admin', 'services/tool-api']);
  });
  it('keeps scoped npm packages whole', () => {
    const b = parseDepRequests([{ path: 'contracts/CHANGE_REQUESTS/Q1-1.md', text: 'Kind: dependency\n- npm: `@aws-sdk/client-s3@^3.600.0` in services/media\n' }]);
    expect(b[0]).toMatchObject({ name: '@aws-sdk/client-s3', ecosystem: 'npm' });
    expect(b[0]!.requests[0]!.range).toBe('^3.600.0');
  });
  it('reports dependency requests it cannot read so P3 can ask the author', () => {
    const bad = [{ path: 'contracts/CHANGE_REQUESTS/X1-1.md', text: 'Kind: dependency\nplease add lodash\n' }];
    expect(parseDepRequests(bad)).toEqual([]);
    expect(unparsedDepRequests(bad)).toEqual(['X1-1']);
    expect(unparsedDepRequests(files)).toEqual([]);
  });
  it('renders a short markdown summary for the daily PR body', () => {
    expect(renderDepBatch(parseDepRequests(files))).toMatch(/zod.*A1-2.*T2-1/s);
  });
});
