/**
 * Task results from the telemetry tables: the `task_measure` rows the
 * recorder writes on every task_result (one per trait a task measured), and
 * the `scoring` block in sessions.profile. Pure functions, testable without a
 * database. Scoring rules: core/director/taskscore.ts, docs/scoring.md.
 */
import type { EventRow } from './metrics';

const SLIDERS = ['risk', 'patience', 'social', 'exploration'] as const;
const MEASURED_ONLY = ['helpfulness', 'learning', 'adaptability', 'calibration', 'trust', 'trustworthiness', 'boredom'] as const;

export interface TaskRow {
  world_id: number;
  task: string;
  version: string;
  room: number | null;
  trait: string | null;
  /** 0..1, or null when the task measured nothing. */
  value: number | null;
  weight: number | null;
  /** False for measurements recorded but not scored (smoke with nobody else there). */
  counts: boolean;
  evidence: string | null;
  metrics: Record<string, number | null>;
}

/** One row per task measurement in a session's events. */
export function taskRows(worldId: number, events: EventRow[]): TaskRow[] {
  return events
    .filter((e) => e.type === 'task_measure')
    .map((e) => {
      const m = e.meta ?? {};
      return {
        world_id: worldId,
        task: String(m.task ?? e.choice ?? '?'),
        version: String(m.version ?? 'office'),
        room: typeof m.task_room === 'number' ? m.task_room : null,
        trait: e.trait,
        value: typeof m.value === 'number' ? m.value : null,
        weight: typeof m.weight === 'number' ? m.weight : null,
        counts: m.counts !== false,
        evidence: typeof m.evidence === 'string' ? m.evidence : null,
        metrics: (m.metrics as Record<string, number | null>) ?? {},
      };
    });
}

/** Per trait, the weighted average (0..1) of the session's task measurements that count. */
export function taskTraitValues(rows: TaskRow[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of [...SLIDERS, ...MEASURED_ONLY]) {
    const xs = rows.filter((r) => r.trait === t && r.counts && r.value !== null && r.weight);
    const w = xs.reduce((a, r) => a + r.weight!, 0);
    out[`task_${t}`] = w ? xs.reduce((a, r) => a + r.value! * r.weight!, 0) / w : null;
  }
  return out;
}

/** The final 1–5 scores stored at the end of the run (sessions.profile.scoring), slider and measured-only. */
export function finalScores(profile: unknown): Record<string, number | null> {
  const s = (profile as { scoring?: { traits?: Record<string, { score?: number; not_tested?: boolean }>; also_measured?: { trait: string; score: number }[] } } | null)?.scoring;
  const out: Record<string, number | null> = {};
  for (const t of SLIDERS) {
    const x = s?.traits?.[t];
    out[`score_${t}`] = x && !x.not_tested && typeof x.score === 'number' ? x.score : null;
  }
  for (const t of MEASURED_ONLY) out[`score_${t}`] = s?.also_measured?.find((a) => a.trait === t)?.score ?? null;
  return out;
}
