import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { findOverlaps, outsideOwnership, specsOverlap } from '../ownership.js';
import { ISSUES } from '../issues.js';
import { renderBrief } from '../brief.js';

describe('ownership specs', () => {
  it('detects overlaps', () => {
    expect(specsOverlap('a/b/**', 'a/b/c.ts')).toBe(true);
    expect(specsOverlap('a/b/**', 'a/bc/d.ts')).toBe(false);
    expect(specsOverlap('a/**', 'a/b/**')).toBe(true);
    expect(specsOverlap('x.ts', 'y.ts')).toBe(false);
  });
  it('flags files outside ownership', () => {
    expect(outsideOwnership(['src/a/**'], ['src/a/x.ts', 'src/b/y.ts'], () => false)).toEqual(['src/b/y.ts']);
  });
});

describe('the parallel plan', () => {
  it('has no two issues owning the same path (so 50 agents never collide)', () => {
    expect(findOverlaps(ISSUES)).toEqual([]);
  });
  it('has unique ids and uses only known agents', () => {
    expect(new Set(ISSUES.map((i) => i.id)).size).toBe(ISSUES.length);
    expect(ISSUES.every((i) => ['claude', 'devin', 'cursor-grok', 'human'].includes(i.agent))).toBe(true);
  });
  it('runs everything except UI and the real-call spike on agents', () => {
    const humans = ISSUES.filter((i) => i.agent === 'human').map((i) => i.id);
    expect(humans.sort()).toEqual(['E8', 'U1']);
    expect(ISSUES.filter((i) => i.agent !== 'human').length).toBeGreaterThanOrEqual(45);
  });
  it('points every issue at skills that exist', () => {
    const missing = ISSUES.flatMap((i) => i.skills.filter((s) => !existsSync(`.claude/skills/${s}/SKILL.md`)).map((s) => `${i.id}:${s}`));
    expect(missing).toEqual([]);
  });
  it('owns every pre-existing stub that a lane must finish', () => {
    const stubs = ['services/channels/src/owner-chat.ts', 'services/provisioning/src/steps/render-agent.ts', 'engines/livekit-agent/src/frontdesk/events.py', 'infra/cdk/lib/realtime-stack.ts'];
    for (const f of stubs) expect(ISSUES.some((i) => i.owns.some((o) => o === f || (o.endsWith('/**') && f.startsWith(o.slice(0, -2))))), f).toBe(true);
  });
  it('renders self-contained briefs with the PR tag', () => {
    expect(renderBrief(ISSUES[1]!)).toContain('[1145:P1]');
  });
});
