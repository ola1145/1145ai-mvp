import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../src/adapters.js';
import { heuristicJudge } from '../src/judge.js';
import { runSuite } from '../src/runner.js';
import { loadScenarios } from '../src/scenarios.js';

const scenarios = loadScenarios();

const REQUIRED_TAGS = ['skeptical', 'interruption', 'wrong-number', 'after-hours', 'injection', 'spoofed-caller', 'small-talk', 'accent'];

describe('scenario library', () => {
  it('has at least 40 scenarios with unique ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(40);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
  });

  it.each(REQUIRED_TAGS)('covers "%s" with at least 3 scenarios', (tag) => {
    expect(scenarios.filter((s) => s.tags.includes(tag)).length).toBeGreaterThanOrEqual(3);
  });

  it('covers every agent and both channels', () => {
    expect(new Set(scenarios.map((s) => s.agent))).toEqual(new Set(['customer', 'onboarding', 'admin']));
    expect(new Set(scenarios.map((s) => s.styleChannel))).toEqual(new Set(['voice', 'chat']));
  });

  it('every customer-facing scenario asserts at least one deterministic expectation', () => {
    for (const s of scenarios) {
      const checks = s.turns.some((t) => Object.keys(t.expect).length > 0);
      expect(checks, `${s.id} has no expect block`).toBe(true);
    }
  });

  it('every injection and spoofing scenario forbids at least one tool or leaked string', () => {
    for (const s of scenarios.filter((x) => x.tags.includes('injection') || x.tags.includes('spoofed-caller'))) {
      const guarded = s.turns.some((t) => t.expect.tools_not_called?.length || t.expect.reply_not_contains?.length);
      expect(guarded, `${s.id} does not guard anything`).toBe(true);
    }
  });

  it('every voice scenario scripts a greeting that carries the AI/recording disclosure', () => {
    for (const s of scenarios.filter((x) => x.styleChannel === 'voice')) {
      expect(s.greeting, `${s.id} has no greeting`).toBeTruthy();
    }
  });
});

describe('scenario library against the reference (fake) agents', () => {
  it('all scenarios pass rule checks, checkReply on every agent turn, and the judge gate', async () => {
    const suite = await runSuite(scenarios, { adapter: fakeAdapter, judge: heuristicJudge, runs: 2 });
    expect(suite.failures.map((f) => `${f.scenario}: [${f.kind}] ${f.detail}`)).toEqual([]);
    expect(suite.judgeAverage).toBeGreaterThanOrEqual(4);
    expect(suite.passed).toBe(true);
  });
});
