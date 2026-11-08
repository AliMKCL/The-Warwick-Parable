import { describe, expect, it } from 'vitest';
import { aggregate, percentile, playerMetrics, type EventRow } from '../../tools/analysis/metrics';

const ev = (type: string, o: Partial<EventRow> = {}): EventRow => ({
  session_id: 's', room: 'r', type, choice: null, trait: null, trait_value: null, latency_ms: null, meta: {}, ...o,
});
const choice = (trait: string, value: string, latency: number, pressure = false) =>
  ev('choice', { trait, trait_value: value, latency_ms: latency, meta: { pressure } });

describe('analysis metrics', () => {
  it('computes rates, latencies, tasks, pressure differences and self-rating gaps', () => {
    const events = [
      ev('room_enter'), ev('room_enter'),
      ev('interact'), ev('interact'), ev('interact'),
      ev('task_start'), ev('task_done'), ev('task_start'), ev('task_skipped'),
      choice('social', 'follow', 1000),
      choice('social', 'independent', 3000, true),
      choice('exploration', 'explore', 2000),
      choice('patience', 'now', 4000, true),
      ev('choice', { latency_ms: 2000 }),
    ];
    const { metrics: m } = playerMetrics({ id: 's', world_id: 1, created_at: '', completed: true, self_ratings: { social: 5, exploration: 1, risk: null } }, events);
    expect(m.follow_rate).toBe(0.5);
    expect(m.exploration_rate).toBe(1);
    expect(m.patience_rate).toBe(0);
    expect(m.risky_rate).toBeNull();
    expect(m.median_latency_ms).toBe(2000);
    expect(m.patience_rel_latency).toBe(2);
    expect(m.tasks_completed).toBe(1);
    expect(m.tasks_skipped).toBe(1);
    expect(m.interactions_per_room).toBe(1.5);
    expect(m.latency_pressure_minus_calm_ms).toBe(1500);
    expect(m.social_self_gap).toBe(0.5);
    expect(m.exploration_self_gap).toBe(-1);
    expect(m.risk_self_gap).toBeNull();
  });

  it('aggregates across players, skipping missing values', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    const a = aggregate([
      { session: 'a', world_id: 1, metrics: { x: 1, y: null } },
      { session: 'b', world_id: 2, metrics: { x: 3, y: 2 } },
    ]);
    expect(a.find((r) => r.metric === 'x')).toMatchObject({ n: 2, mean: 2, p50: 2 });
    expect(a.find((r) => r.metric === 'y')).toMatchObject({ n: 1, mean: 2 });
  });
});
