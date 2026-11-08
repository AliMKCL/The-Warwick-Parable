/**
 * A Bayesian estimate of one trait on [0, 1], kept as a posterior over a fixed
 * grid of θ values. Evidence arrives as item responses from a two-parameter
 * logistic (2PL) model, the standard model in item response theory:
 *
 *   P(y = 1 | θ) = 1 / (1 + e^(−a(θ − b)))
 *
 * `a` is the discrimination (how sharply a test separates low from high θ)
 * and `b` the difficulty (the θ at which the outcome is 50/50). A grid of 51
 * points is exact enough for a 0–1 score and costs microseconds per update.
 */

export const GRID_SIZE = 51;
const LO = 0.02;
const HI = 0.98;
export const GRID: Float64Array = (() => {
  const g = new Float64Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) g[i] = LO + ((HI - LO) * i) / (GRID_SIZE - 1);
  return g;
})();

/** One test outcome as an IRT item: which trait, how sharply it separates (a), and where (b). */
export interface Item {
  a: number;
  b: number;
}

/**
 * Profile evidence is a capped nudge (+0.14, −0.18…). Each nudge is read as a
 * response to a neutral item (a = 8, b = 0.5) weighted by its size in these units,
 * so a nudge of 0.1 counts as one full response. At the 0.5 prior that moves the
 * mean by about the nudge itself, which keeps the game's feel; later evidence moves
 * a trait less as the estimate firms up, and contradicting evidence cancels.
 */
export const EVIDENCE_ITEM: Item = { a: 8, b: 0.5 };
export const EVIDENCE_UNIT = 0.1;

export const PRIOR_SD = 0.2;

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class TraitPosterior {
  /** Log posterior, unnormalised. */
  private logp = new Float64Array(GRID_SIZE);
  private probs = new Float64Array(GRID_SIZE);
  private dirty = true;
  /** Responses observed so far (weighted). */
  count = 0;

  constructor(mean = 0.5, sd = PRIOR_SD) {
    for (let i = 0; i < GRID_SIZE; i++) this.logp[i] = -0.5 * ((GRID[i]! - mean) / sd) ** 2;
  }

  /** Bayes' rule on the grid: multiply in P(y | θ)^weight. */
  observe(y: 0 | 1, item: Item, weight = 1): void {
    if (!(weight > 0)) return;
    for (let i = 0; i < GRID_SIZE; i++) {
      const p = logistic(item.a * (GRID[i]! - item.b));
      this.logp[i]! += weight * Math.log(y ? p : 1 - p);
    }
    this.count += weight;
    this.dirty = true;
  }

  /** Normalised posterior probabilities. */
  p(): Float64Array {
    if (!this.dirty) return this.probs;
    let max = -Infinity;
    for (let i = 0; i < GRID_SIZE; i++) max = Math.max(max, this.logp[i]!);
    let sum = 0;
    for (let i = 0; i < GRID_SIZE; i++) sum += this.probs[i] = Math.exp(this.logp[i]! - max);
    for (let i = 0; i < GRID_SIZE; i++) this.probs[i]! /= sum;
    this.dirty = false;
    return this.probs;
  }

  mean(): number {
    const p = this.p();
    let m = 0;
    for (let i = 0; i < GRID_SIZE; i++) m += p[i]! * GRID[i]!;
    return m;
  }

  sd(): number {
    const p = this.p();
    const m = this.mean();
    let v = 0;
    for (let i = 0; i < GRID_SIZE; i++) v += p[i]! * (GRID[i]! - m) ** 2;
    return Math.sqrt(v);
  }

  /** Probability mass in [lo, hi]: how sure we are the trait is in a band. */
  mass(lo: number, hi: number): number {
    const p = this.p();
    let s = 0;
    for (let i = 0; i < GRID_SIZE; i++) if (GRID[i]! >= lo && GRID[i]! <= hi) s += p[i]!;
    return s;
  }

  /**
   * Expected information gain of one more response to `item`, in bits: the
   * mutual information I(θ; y) = H(y) − E_θ[H(y | θ)]. High when the item's
   * 50/50 point sits where the posterior is still unsure; zero for a trait that
   * is already pinned down or an item that can't separate anything.
   */
  infoGain(item: Item): number {
    const p = this.p();
    let py = 0;
    let condH = 0;
    for (let i = 0; i < GRID_SIZE; i++) {
      const q = logistic(item.a * (GRID[i]! - item.b));
      py += p[i]! * q;
      condH += p[i]! * h2(q);
    }
    return Math.max(0, h2(py) - condH);
  }

  /** A θ drawn from the posterior (for simulations). */
  sample(u: number): number {
    const p = this.p();
    let c = 0;
    for (let i = 0; i < GRID_SIZE; i++) if ((c += p[i]!) >= u) return GRID[i]!;
    return GRID[GRID_SIZE - 1]!;
  }
}

/** Binary entropy in bits. */
function h2(q: number): number {
  if (q <= 1e-12 || q >= 1 - 1e-12) return 0;
  return -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));
}
