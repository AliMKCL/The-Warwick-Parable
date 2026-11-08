/**
 * Pulls play data from Supabase and prints per-player metrics plus population aggregates.
 *
 *   npm run analyze                    completed sessions only
 *   npm run analyze -- --all           include sessions that never reached the dossier
 *   npm run analyze -- --json out.json also write everything as JSON
 *   npm run analyze -- --csv out.csv   also write the per-player table as CSV
 *
 * Also prints every office-task measurement (task_measure rows) and each
 * player's final trait scores, including the traits with no slider.
 *
 * Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env / .env.local.
 */
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { loadProjectEnv } from './env';
import { aggregate, playerMetrics, type EventRow, type SessionRow } from './analysis/metrics';
import { finalScores, taskRows, taskTraitValues } from './analysis/tasks';

loadProjectEnv();
const url = process.env.VITE_SUPABASE_URL, key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local first.');
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = createClient(url, key, { auth: { persistSession: false } });
const PAGE = 1000;

async function sessions(): Promise<SessionRow[]> {
  const out: SessionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from('sessions').select('id, world_id, created_at, self_ratings, completed, profile').order('world_id').range(from, from + PAGE - 1);
    if (!args.includes('--all')) q = q.eq('completed', true);
    const { data, error } = await q;
    if (error) {
      console.error(`Could not read sessions: ${error.message}${error.code === 'PGRST205' ? '\nRun supabase/schema.sql in the Supabase SQL editor first.' : ''}`);
      process.exit(1);
    }
    out.push(...(data as SessionRow[]));
    if (data.length < PAGE) return out;
  }
}

async function events(ids: string[]): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('events')
        .select('session_id, room, type, choice, trait, trait_value, latency_ms, meta')
        .in('session_id', chunk)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`events: ${error.message}`);
      out.push(...(data as EventRow[]));
      if (data.length < PAGE) break;
    }
  }
  return out;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '' : Number.isInteger(v) ? v : Number(v.toFixed(3)));

const ss = await sessions();
if (!ss.length) {
  console.log(args.includes('--all') ? 'No sessions yet.' : 'No completed sessions yet (try --all).');
  process.exit(0);
}
const evs = await events(ss.map((s) => s.id));
const bySession = new Map<string, EventRow[]>();
for (const e of evs) (bySession.get(e.session_id) ?? bySession.set(e.session_id, []).get(e.session_id)!).push(e);
const seq = (e: EventRow) => Number(e.meta?.seq ?? 0);
const players = ss.map((s) => {
  const rows = (bySession.get(s.id) ?? []).sort((a, b) => seq(a) - seq(b));
  const p = playerMetrics(s, rows);
  // Task-based trait values (0..1) and the final 1-5 scores, next to the choice-based metrics.
  Object.assign(p.metrics, taskTraitValues(taskRows(s.world_id, rows)), finalScores(s.profile));
  return p;
});
const tasks = ss.flatMap((s) => taskRows(s.world_id, bySession.get(s.id) ?? []));
const pop = aggregate(players);

console.log(`\n${players.length} sessions, ${evs.length} events\n`);
console.log('Per player');
console.table(Object.fromEntries(players.map((p) => [`world ${p.world_id}`, Object.fromEntries(Object.entries(p.metrics).map(([k, v]) => [k, fmt(v)]))])));
if (tasks.length) {
  console.log('\nTask results (value 0..1 for the trait; "recorded only" = not scored)');
  console.table(tasks.map((t) => ({ world: t.world_id, task: t.task, version: t.version, room: t.room ?? '', trait: t.trait ?? '', value: fmt(t.value), weight: t.weight ?? '', scored: t.counts ? 'yes' : 'recorded only', evidence: t.evidence ?? '' })));
  const ids = [...new Set(tasks.map((t) => t.task))];
  console.log('\nTask results by task');
  console.table(Object.fromEntries(ids.map((id) => {
    const xs = tasks.filter((t) => t.task === id && t.value !== null);
    const vals = xs.map((t) => t.value!);
    return [id, { n: xs.length, traits: [...new Set(xs.map((t) => t.trait))].join(', '), mean: fmt(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null), min: fmt(vals.length ? Math.min(...vals) : null), max: fmt(vals.length ? Math.max(...vals) : null) }];
  })));
  const lifts = tasks.filter((t) => t.task === 'lift').map((t) => t.metrics.seconds_waited).filter((v): v is number => typeof v === 'number');
  if (lifts.length) console.log(`Lift seconds_waited (to calibrate LIFT_PATIENCE_BANDS): ${lifts.sort((a, b) => a - b).map((v) => Math.round(v)).join(', ')}`);
} else console.log('\nNo task results yet.');

console.log('\nPopulation');
console.table(Object.fromEntries(pop.map(({ metric, ...a }) => [metric, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, fmt(v)]))])));

const json = flag('--json');
if (json) {
  writeFileSync(json, JSON.stringify({ generated: new Date().toISOString(), players, population: pop, tasks }, null, 2));
  console.log(`Wrote ${json}`);
}
const csv = flag('--csv');
if (csv) {
  const cols = [...new Set(players.flatMap((p) => Object.keys(p.metrics)))];
  const lines = [['world_id', 'session', ...cols].join(','), ...players.map((p) => [p.world_id, p.session, ...cols.map((c) => p.metrics[c] ?? '')].join(','))];
  writeFileSync(csv, lines.join('\n') + '\n');
  console.log(`Wrote ${csv}`);
}
