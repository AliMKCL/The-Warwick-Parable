/**
 * Paired tasks and the balancing rule (build spec, "Paired tasks and the balancing rule").
 *
 * Tasks 6 to 10b have an office version and a mine version. Whatever the
 * player gives in the office, the mine supplies the rest, and keeps going
 * only until the trait is measured precisely enough. The office versions
 * live in core/tasks/office; this is the bookkeeping the mine will use.
 */
export interface PairedTask {
  /** Office module id. */
  id: string;
  number: string;
  unit: string;
  /** N: target total observations across both versions. */
  target: number;
  officeMax: number;
  /** m_min and M: the mine's minimum and maximum. */
  minMine: number;
  max: number;
  /** Keep adding mine trials while the trait's standard error is above this (percentile points). */
  targetSE: number;
}

export const PAIRED: PairedTask[] = [
  { id: 'balloons', number: '6', unit: 'balloons, then ore veins', target: 12, officeMax: 10, minMine: 3, max: 12, targetSE: 10 },
  { id: 'coffee', number: '7', unit: 'picks', target: 24, officeMax: 12, minMine: 10, max: 24, targetSE: 10 },
  { id: 'canteen', number: '8', unit: 'offers', target: 6, officeMax: 4, minMine: 2, max: 6, targetSE: 10 },
  { id: 'renumbered', number: '9', unit: 'junctions (one rule switch per version)', target: 16, officeMax: 8, minMine: 6, max: 12, targetSE: 10 },
  { id: 'pitch', number: '10a', unit: 'pitches, then cart jumps', target: 8, officeMax: 5, minMine: 3, max: 8, targetSE: 10 },
  { id: 'loan', number: '10b', unit: 'rounds (2 trusting, 1 trusted)', target: 3, officeMax: 2, minMine: 1, max: 3, targetSE: 10 },
];

/** n_mine = min(M, max(m_min, N - n_office)). */
export function baseMineTrials(t: PairedTask, officeN: number): number {
  return Math.min(t.max, Math.max(t.minMine, t.target - officeN));
}

/** Checked after every mine trial: one more while the band is still wide and the maximum isn't reached. */
export function wantsAnother(t: PairedTask, doneInMine: number, traitSE: number): boolean {
  return doneInMine < t.max && traitSE > t.targetSE;
}

/**
 * Does a trait hold in both settings? z = (mean_office - mean_mine) / sqrt(SE_office^2 + SE_mine^2).
 * |z| < 1 consistent, > 2 context-dependent; only with at least 3 observations in each (trust excepted).
 */
export function compareSettings(
  office: { mean: number; se: number; n: number },
  mine: { mean: number; se: number; n: number },
  minN = 3,
): { z: number; verdict: 'consistent' | 'context-dependent' | 'unclear' } | null {
  if (office.n < minN || mine.n < minN) return null;
  const den = Math.sqrt(office.se ** 2 + mine.se ** 2);
  if (!den) return null;
  const z = (office.mean - mine.mean) / den;
  return { z, verdict: Math.abs(z) < 1 ? 'consistent' : Math.abs(z) > 2 ? 'context-dependent' : 'unclear' };
}
