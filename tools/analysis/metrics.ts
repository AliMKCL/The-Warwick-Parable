/**
 * Behaviour metrics from the telemetry tables (supabase/schema.sql).
 * Pure functions, so they can be tested without a database.
 */

export type Trait = 'risk' | 'patience' | 'social' | 'exploration';
export const TRAITS: Trait[] = ['risk', 'patience', 'social', 'exploration'];
/** The value of each trait that counts towards its rate. */
const POSITIVE: Record<Trait, string> = { risk: 'risky', patience: 'wait', social: 'follow', exploration: 'explore' };
const RATE_NAME: Record<Trait, string> = { risk: 'risky_rate', patience: 'patience_rate', social: 'follow_rate', exploration: 'exploration_rate' };

export interface SessionRow {
  id: string;
  world_id: number;
  created_at: string;
  self_ratings: Partial<Record<Trait, number | null>> | null;
  completed: boolean | null;
  /** The end-of-run profile (with `scoring`), when selected. */
  profile?: unknown;
}

export interface EventRow {
  session_id: string;
  room: string | null;
  type: string;
  choice: string | null;
  trait: string | null;
  trait_value: string | null;
  latency_ms: number | null;
  meta: Record<string, unknown> | null;
}

export type Metrics = Record<string, number | null>;

export interface PlayerMetrics {
  session: string;
  world_id: number;
  metrics: Metrics;
}

export function median(xs: number[]): number | null {
  return percentile(xs, 50);
}

/** Linear-interpolated percentile (p in 0..100); null for no data. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

/** Share of choices tagged with `trait` whose value is its positive pole; null when there were none. */
function rate(choices: EventRow[], trait: Trait): number | null {
  const tagged = choices.filter((c) => c.trait === trait && c.trait_value);
  return tagged.length ? tagged.filter((c) => c.trait_value === POSITIVE[trait]).length / tagged.length : null;
}

const pressured = (e: EventRow) => e.meta?.pressure === true;

export function playerMetrics(session: SessionRow, events: EventRow[]): PlayerMetrics {
  const choices = events.filter((e) => e.type === 'choice');
  const timed = choices.filter((c) => typeof c.latency_ms === 'number') as (EventRow & { latency_ms: number })[];
  const own = median(timed.map((c) => c.latency_ms));
  const rel = (cs: typeof timed) => (own ? median(cs.map((c) => c.latency_ms / own)) : null);
  const pressure = timed.filter(pressured), calm = timed.filter((c) => !pressured(c));
  const rooms = events.filter((e) => e.type === 'room_enter').length;
  const interactions = events.filter((e) => e.type === 'interact').length;

  const m: Metrics = { choices: choices.length };
  for (const t of TRAITS) {
    m[RATE_NAME[t]] = rate(choices, t);
    m[`${t}_n`] = choices.filter((c) => c.trait === t && c.trait_value).length;
  }
  m.median_latency_ms = own;
  for (const t of TRAITS) m[`${t}_rel_latency`] = rel(timed.filter((c) => c.trait === t));
  m.tasks_started = events.filter((e) => e.type === 'task_start').length;
  m.tasks_completed = events.filter((e) => e.type === 'task_done').length;
  m.tasks_skipped = events.filter((e) => e.type === 'task_skipped').length;
  m.rooms = rooms;
  m.interactions = interactions;
  m.interactions_per_room = rooms ? interactions / rooms : null;
  m.backtrack_attempts = events.filter((e) => e.type === 'backtrack_attempt').length;

  m.pressure_choices = pressure.length;
  m.calm_choices = calm.length;
  m.risky_rate_pressure = rate(choices.filter(pressured), 'risk');
  m.risky_rate_calm = rate(choices.filter((c) => !pressured(c)), 'risk');
  m.risky_rate_pressure_minus_calm = diff(m.risky_rate_pressure, m.risky_rate_calm);
  m.median_latency_pressure_ms = median(pressure.map((c) => c.latency_ms));
  m.median_latency_calm_ms = median(calm.map((c) => c.latency_ms));
  m.latency_pressure_minus_calm_ms = diff(m.median_latency_pressure_ms, m.median_latency_calm_ms);
  m.rel_latency_pressure_minus_calm = diff(rel(pressure), rel(calm));

  // Self-ratings are 1-5; mapped onto 0-1 to compare with rates. Positive gap: rated themselves higher than they behaved.
  for (const t of TRAITS) {
    const r = session.self_ratings?.[t];
    const self = typeof r === 'number' ? (r - 1) / 4 : null;
    m[`${t}_self`] = self;
    m[`${t}_self_gap`] = diff(self, m[RATE_NAME[t]] ?? null);
  }
  return { session: session.id, world_id: session.world_id, metrics: m };
}

export interface Aggregate {
  metric: string;
  n: number;
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

/** Mean and percentiles of every metric across players, ignoring players with no data for it. */
export function aggregate(players: PlayerMetrics[]): Aggregate[] {
  const names = [...new Set(players.flatMap((p) => Object.keys(p.metrics)))];
  return names.map((metric) => {
    const xs = players.map((p) => p.metrics[metric]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return {
      metric,
      n: xs.length,
      mean: mean(xs),
      p10: percentile(xs, 10),
      p25: percentile(xs, 25),
      p50: percentile(xs, 50),
      p75: percentile(xs, 75),
      p90: percentile(xs, 90),
    };
  });
}
