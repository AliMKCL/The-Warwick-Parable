import { describe, expect, it } from 'vitest';
import { EVIDENCE_ITEM, GRID, TraitPosterior } from '../../core/profile/bayes';
import { gameData } from '../../core/data';
import { Profile } from '../../core/profile/profile';
import { TEST_KINDS, TESTS } from '../../core/testrooms/registry';
import { resolveLayout } from '../../core/testrooms/config';
import { EXPOSURE, scoreTests } from '../../core/testrooms/schedule';

describe('trait posterior', () => {
  it('starts at 0.5 with sd 0.2 and sums to one', () => {
    const t = new TraitPosterior();
    expect(t.mean()).toBeCloseTo(0.5, 6);
    expect(t.sd()).toBeGreaterThan(0.17);
    expect(t.sd()).toBeLessThanOrEqual(0.2);
    expect(t.p().reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    expect(GRID.length).toBe(51);
  });

  it('firms up with consistent evidence and cancels contradicting evidence', () => {
    const up = new TraitPosterior();
    const sds = [up.sd()];
    for (let i = 0; i < 5; i++) { up.observe(1, EVIDENCE_ITEM); sds.push(up.sd()); }
    expect(up.mean()).toBeGreaterThan(0.7);
    sds.forEach((s, i) => i && expect(s).toBeLessThan(sds[i - 1]!));
    const both = new TraitPosterior();
    both.observe(1, EVIDENCE_ITEM, 2);
    both.observe(0, EVIDENCE_ITEM, 2);
    expect(both.mean()).toBeCloseTo(0.5, 6);
    expect(both.sd()).toBeLessThan(new TraitPosterior().sd()); // contradicting evidence still teaches something
  });

  it('expected information gain: most where the posterior is unsure, little once pinned down, zero for a useless item', () => {
    const fresh = new TraitPosterior();
    const pinned = new TraitPosterior();
    for (let i = 0; i < 30; i++) pinned.observe(1, EVIDENCE_ITEM);
    expect(fresh.infoGain({ a: 8, b: 0.5 })).toBeGreaterThan(pinned.infoGain({ a: 8, b: 0.5 }) * 3);
    expect(fresh.infoGain({ a: 0, b: 0.5 })).toBeCloseTo(0, 9);
    // An item at the posterior's centre beats one far out in the tail.
    expect(fresh.infoGain({ a: 8, b: 0.5 })).toBeGreaterThan(fresh.infoGain({ a: 8, b: 0.9 }));
    // Never more than one bit for a yes/no outcome.
    expect(fresh.infoGain({ a: 200, b: 0.5 })).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('every test that moves the profile declares what it measures', () => {
    for (const k of TEST_KINDS) if (k.id !== 'choice') expect(k.measures?.length, k.id).toBeGreaterThan(0);
  });

  it('logs evidence with the change it actually made to the estimate', () => {
    const p = new Profile(gameData);
    const room = { id: 'r', index: 1 } as never;
    p.adjust('compliance', 0.18, 'a', room, 1);
    p.adjust('compliance', -0.18, 'b', { id: 'r2', index: 2 } as never, 2);
    expect(p.evidence[0]!.delta).toBeGreaterThan(0.1);
    expect(p.evidence[1]!.delta).toBeLessThan(-0.1);
    expect(p.traits.compliance).toBeCloseTo(0.5, 2);
    expect(p.sd().compliance).toBeLessThan(0.2);
  });

  it('a middling outcome still counts: the estimate firms up without moving, and no evidence is listed', () => {
    const p = new Profile(gameData);
    p.neutral('hesitation', { a: 7, b: 0.55 });
    expect(p.sd().hesitation).toBeLessThan(0.19);
    expect(Math.abs(p.traits.hesitation - 0.5)).toBeLessThan(0.03);
    expect(p.evidence).toHaveLength(0);
  });

  it('exposure control: a test already used this run is drawn less', () => {
    const p = new Profile(gameData);
    const kinds = [TESTS.exit_timer!, TESTS.narrator_suggests!];
    const pool = resolveLayout(gameData.layout).pool;
    const fresh = scoreTests(kinds, pool, p, 'adaptive', 4);
    const used = scoreTests(kinds, pool, p, 'adaptive', 4, { exit_timer: 2 });
    expect(used[0]!.score).toBeCloseTo(fresh[0]!.score * EXPOSURE ** 2, 9);
    expect(used[1]!.score).toBeCloseTo(fresh[1]!.score, 9);
  });
});
