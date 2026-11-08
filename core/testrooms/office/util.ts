import type { TaskEvent } from '../../protocol';

/** Small helpers shared by the office task modules' scoring. */

export const of = (events: TaskEvent[], type: string, pred: (d: Record<string, unknown>) => boolean = () => true) =>
  events.filter((e) => e.type === type && pred(e.data));

export const first = (events: TaskEvent[], type: string, pred?: (d: Record<string, unknown>) => boolean) => of(events, type, pred)[0];

/** Two decimals; null for missing or non-finite values. */
export const r2 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Least-squares slope of y on x. */
export function slope(points: [number, number][]): number | null {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p[0]))!, my = mean(points.map((p) => p[1]))!;
  let num = 0, den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : null;
}

export const s0 = (n: number) => `${Math.round(n)} s`;
