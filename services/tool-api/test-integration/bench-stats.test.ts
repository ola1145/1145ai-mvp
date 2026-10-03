import { describe, expect, it } from 'vitest';
import { percentile } from '../bench/stats.js';

describe('bench percentile (nearest rank)', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  it('matches the textbook definition', () => {
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile(s, 100)).toBe(100);
  });
  it('handles small and empty samples', () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 95)).toBeNaN();
  });
});
