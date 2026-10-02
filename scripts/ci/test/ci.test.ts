import { describe, expect, it } from 'vitest';
import { contractGuard, ownershipViolations, prTag } from '../lib.js';
import { fromPython, fromTypeScript } from '../extract-copy.js';

const pr = (title: string, changed: string[], labels: string[] = [], author = 'devin-ai-integration[bot]') => ({ title, changed, labels, author, repoOwner: 'ola1145' });

describe('PR tag', () => {
  it('parses the issue id', () => {
    expect(prTag('[1145:T1] reschedule')).toBe('T1');
    expect(prTag('reschedule')).toBeUndefined();
  });
});

describe('ownership check', () => {
  it('passes files the issue owns and its own change requests', () => {
    expect(ownershipViolations(pr('[1145:T1] x', ['services/tool-api/src/lib/verification.ts', 'contracts/CHANGE_REQUESTS/T1-1.md'])).ok).toBe(true);
  });
  it('fails files owned by another lane, with an actionable message', () => {
    const r = ownershipViolations(pr('[1145:T1] x', ['services/tool-api/src/lib/repo.ts']));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('CHANGE_REQUESTS');
  });
  it('fails untagged PRs and only exempts orchestrator PRs from the repo owner', () => {
    expect(ownershipViolations(pr('fix stuff', ['a.ts'])).ok).toBe(false);
    expect(ownershipViolations(pr('fix stuff', ['a.ts'], ['orchestrator'])).ok).toBe(false);
    expect(ownershipViolations(pr('fix stuff', ['a.ts'], ['orchestrator'], 'ola1145')).ok).toBe(true);
  });
  it('blocks lockfile edits from any lane but P3', () => {
    expect(ownershipViolations(pr('[1145:C3] x', ['pnpm-lock.yaml'])).ok).toBe(false);
    expect(ownershipViolations(pr('[1145:P3] lock', ['pnpm-lock.yaml'])).ok).toBe(true);
  });
});

describe('contract guard', () => {
  it('requires the label for contract changes but not for change requests', () => {
    expect(contractGuard({ labels: [], changed: ['contracts/openapi/tenant-tools.yaml'] }).ok).toBe(false);
    expect(contractGuard({ labels: ['contract-change'], changed: ['packages/shared/src/events.ts'] }).ok).toBe(true);
    expect(contractGuard({ labels: [], changed: ['contracts/CHANGE_REQUESTS/T1-1.md'] }).ok).toBe(true);
  });
});

describe('copy extraction', () => {
  it('finds spoken lines in TS and Python', () => {
    const ts = fromTypeScript('a.ts', "return { sayToCaller: `You're all set ${when}.` , x: 1 }");
    expect(ts[0]).toMatchObject({ channel: 'voice', text: "You're all set X." });
    const py = fromPython('b.py', 'PAUSED = "Thanks for calling!"\nTOOL_API_URL = "http://x"\nFILLERS = (\n  "One sec.",\n  "Let me check.",\n)\n');
    expect(py.map((l) => l.text)).toEqual(['Thanks for calling!', 'One sec.', 'Let me check.']);
  });
});
