import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed, pick, randInt } from '../../core/util/random';

describe('seeded random', () => {
  it('replays the same sequence from the same seed', () => {
    const a = createRng(42), b = createRng(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });
  it('stays within bounds', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const n = randInt(rng, 2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(['a', 'b']).toContain(pick(rng, ['a', 'b']));
  });
  it('derives different child seeds per label', () => {
    expect(deriveSeed(1, 'room-1')).not.toBe(deriveSeed(1, 'room-2'));
    expect(deriveSeed(1, 'room-1')).toBe(deriveSeed(1, 'room-1'));
  });
});
