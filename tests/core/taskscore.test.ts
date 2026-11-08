import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { buildDossier, templateVerdict } from '../../core/director/dossier';
import { compareSelf, measure } from '../../core/director/selfcheck';
import { alsoMeasured, combine, LIFT_PATIENCE_BANDS, scoreTaskResult, scoreTaskResults, TASKS } from '../../core/director/taskscore';
import type { SelfTrait, TaskResult } from '../../core/protocol';
import { Run } from '../../core/run/run';
import { Recorder, scoring } from '../../web/telemetry/recorder';
import type { TelemetryEvent } from '../../web/telemetry/telemetry';
import { goldenOutput } from './scripted-runs';

/**
 * Fake task results in the exact office-tasks format (TaskResult in
 * core/protocol.ts on origin/office-tasks: task, room, title, params,
 * metrics, notes), with every metric each scorer outputs.
 */
const RESULTS = {
  two_doors: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'two_doors', room: 1, title: 'Two Doors',
    params: { instructedSide: 'left', lineVariant: 0, leftDoor: 'd1', rightDoor: 'd2' },
    metrics: { compliance: 1, compliance_latency: 1.4, compliance_latency_z: 0.3, early_action: 0, forbidden_approaches: 0, ...m },
    notes: ['Told to take the left door, you took the left one, 1.4 s after the instruction ended.'],
  }),
  lift: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'lift', room: 2, title: 'The Lift That Never Comes',
    params: { timeout: 90, stairs: 'plain', callProp: 't_call' },
    metrics: { button_presses: 3, peak_press_rate: 1.2, time_to_pivot: 40, restlessness: 0.4, self_rescue: 1, seconds_waited: 47, ...m },
    notes: [],
  }),
  desk: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'desk', room: 3, title: 'The Abandoned Desk',
    params: { items: 5, offset: 'near', itemProps: 't_sticky,t_mug,t_folder,t_photo,t_laptop', shortest: 9 },
    metrics: { items_inspected: 0.6, extra_time: 12, path_ratio: 1.4, reading_depth: 0.9, follow_through: null, used_secret_door: null, ...m },
    notes: [],
  }),
  meeting: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'meeting', room: 4, title: 'Late for the Meeting',
    params: { countdown: 13, helpSeconds: 8 },
    metrics: { helped: 1, help_under_pressure: 1, pressure_effect: null, abandoned_midway: 0, came_back: 0, return_visits: 0, clock_at_help: 9, ...m },
    notes: [],
  }),
  smoke: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'smoke', room: 5, title: 'The Smoky Corridor',
    params: { condition: m.crowd === 0 ? 'alone' : 'crowd', workers: 3, onset: 8, growth: 60 },
    metrics: { reaction_latency: 12, raised_alarm: 0, kept_on_task: 1, social_check: 0, crowd: 1, ...m },
    notes: [],
  }),
  balloons: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'balloons', room: 1, title: 'Balloons',
    params: { maxPumps: 32, balloons: 10, value: 1 },
    metrics: { balloons: 10, adjusted_avg_pumps: 16, collapse_rate: 0.3, post_loss_shift: -3, hesitation_curve: 0.02, party_score: 112, voluntary_repetitions: 10, ...m },
    notes: [],
  }),
  coffee: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'coffee', room: 1, title: 'Coffee',
    params: { recommended: 1, kinds: 'steady,bad,rare', maxPicks: 12, energy: 50 },
    metrics: { picks: 12, net_score: 150, net_per_block: 1, learning_slope: 2, advice_reliance: 0.2, lose_shift_rate: 0.5, win_stay_rate: 0.6, voluntary_repetitions: 12, ...m },
    notes: [],
  }),
  canteen: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'canteen', room: 1, title: 'Canteen',
    params: { offers: 'a,b,c,d', energy: 60, drain: 0.4 },
    metrics: { offers: 4, later_share: 0.75, estimated_k: 0.02, abandon_rate: 0, fidget_during_wait: 0.4, fidget_during_wait_z: 0.1, voluntary_repetitions: 4, ...m },
    notes: [],
  }),
  renumbered: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'renumbered', room: 1, title: 'Renumbered',
    params: { junctions: 7, switchAt: 4, timeout: 240 },
    metrics: { junctions: 7, pre_switch_accuracy: 1, perseverative_errors: 1, junctions_to_adapt: 4, decision_time_change: 1.3, ...m },
    notes: [],
  }),
  pitch: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'pitch', room: 1, title: 'Pitch',
    params: { zoneWidth: 0.2, speed: 0.55, maxPitches: 5 },
    metrics: { pitches: 5, mean_confidence: 0.8, success_rate: 0.5, overconfidence: 0.3, brier: 0.3, confidence_after_fall: -0.1, points: 20, voluntary_repetitions: 5, ...m },
    notes: [],
  }),
  loan: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'loan', room: 1, title: 'Loan',
    params: { partner: 'fair', endowment: 10, flipSent: 4, rounds: 2 },
    metrics: { initial_trust: 0.5, trust_update: 2, partner_fair: 1, trustworthiness: 0.4, rounds: 3, ...m },
    notes: [],
  }),
  lockdown: (m: Partial<Record<string, number | null>> = {}): TaskResult => ({
    task: 'lockdown', room: 1, title: 'Lockdown',
    params: { duration: 90, files: 40 },
    metrics: { lock_seconds: 90, escape_attempts: 2, escalation: 0, peak_spam_rate: null, time_to_explore: 10, task_room_share: 0.6, files_sorted: 6, sort_accuracy: 0.8, buzzer_presses: 1, time_to_first_buzz: 30, idle_share: 0.3, pacing: 20, pacing_z: 0.1, help_seeking: 0, notices_unlock: 2, finishes_job: 0, ...m },
    notes: [],
  }),
};

const one = (r: TaskResult, trait?: string) => {
  const xs = scoreTaskResult(r).filter((x) => !trait || x.trait === trait);
  expect(xs.length).toBeLessThanOrEqual(1);
  return xs[0];
};
const value = (r: TaskResult, trait?: string) => one(r, trait)?.value ?? null;

describe('task scoring rules', () => {
  it('every task 1-11 has an entry, and each entry feeds at least one trait', () => {
    expect(TASKS.map((t) => t.id)).toEqual(['two_doors', 'lift', 'desk', 'meeting', 'smoke', 'balloons', 'coffee', 'canteen', 'renumbered', 'pitch', 'loan', 'lockdown']);
    for (const t of TASKS) expect(t.rules.length).toBeGreaterThan(0);
  });

  it('two doors: obedience, 1 / 0 / 0.5 after approaching the forbidden door, weight 2', () => {
    expect(value(RESULTS.two_doors())).toBe(1);
    expect(value(RESULTS.two_doors({ compliance: 0 }))).toBe(0);
    expect(value(RESULTS.two_doors({ forbidden_approaches: 2 }))).toBe(0.5);
    const m = one(RESULTS.two_doors())!;
    expect(m).toMatchObject({ trait: 'social', weight: 2, graded: false, counts: true, version: 'office', room: 1 });
    expect(m.evidence).toBe('Told to take the left door, you did, 1 s after the instruction ended.');
    expect(one(RESULTS.two_doors({ forbidden_approaches: 2 }))!.evidence).toMatch(/after walking up to the forbidden one twice/);
  });

  it('lift: patience in provisional bands; reaching the hint is 1', () => {
    expect(LIFT_PATIENCE_BANDS.map((b) => b.under)).toEqual([10, 30, 60, Infinity]);
    const at = (s: number, extra = {}) => value(RESULTS.lift({ seconds_waited: s, ...extra }));
    expect([at(4), at(9.9), at(10), at(29), at(30), at(59), at(60), at(89), at(90), at(120)]).toEqual([0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1]);
    expect(at(50, { self_rescue: 0 })).toBe(1); // still there when the narrator gave the hint
    const m = one(RESULTS.lift())!;
    expect(m).toMatchObject({ trait: 'patience', weight: 2, graded: true });
    expect(m.evidence).toBe('Waited 47 s for a lift that never came, pressing the button 3 times.');
    expect(one(RESULTS.lift({ restlessness: 1.5, button_presses: 0 }))!.evidence).toBe('Waited 47 s for a lift that never came, without pressing the button, pacing more than you usually move.');
  });

  it('desk: curiosity is the share of items inspected, with reading depth as evidence', () => {
    const m = one(RESULTS.desk())!;
    expect(m).toMatchObject({ trait: 'exploration', value: 0.6, weight: 2, graded: true });
    expect(m.evidence).toBe('Looked at 3 of the 5 things on the abandoned desk, and read them properly.');
    expect(one(RESULTS.desk({ items_inspected: 0 }))!.evidence).toBe('Walked past the abandoned desk without looking at any of its 5 things.');
  });

  it('meeting: helpfulness, measured only: 1 helped, 0.5 half-helped or came back, 0 walked on', () => {
    expect(value(RESULTS.meeting())).toBe(1);
    expect(value(RESULTS.meeting({ helped: 0, help_under_pressure: 0, abandoned_midway: 1 }))).toBe(0.5);
    expect(value(RESULTS.meeting({ helped: 0, help_under_pressure: 0, came_back: 1 }))).toBe(0.5);
    expect(value(RESULTS.meeting({ helped: 0, help_under_pressure: 0 }))).toBe(0);
    expect(one(RESULTS.meeting())!.trait).toBe('helpfulness');
    expect(one(RESULTS.meeting())!.evidence).toBe("Stopped to fix a stranger's printer with 9 s left before your meeting.");
  });

  it('smoke: obedience reversed, only with a crowd; alone it is recorded but not scored', () => {
    const crowd = one(RESULTS.smoke())!;
    expect(crowd).toMatchObject({ trait: 'social', value: 1, weight: 2, counts: true });
    expect(crowd.evidence).toMatch(/going along with others, not following instructions/);
    expect(value(RESULTS.smoke({ kept_on_task: 0, raised_alarm: 1 }))).toBe(0);
    expect(value(RESULTS.smoke({ kept_on_task: 1, raised_alarm: 1 }))).toBe(0);
    expect(value(RESULTS.smoke({ kept_on_task: 0 }))).toBe(0); // went for the exit / vent first
    const alone = one(RESULTS.smoke({ crowd: 0, social_check: null }))!;
    expect(alone.counts).toBe(false);
    expect(alone.evidence).toMatch(/Recorded only/);
  });

  it('balloons: risk is mean banked pumps as a share of the maximum', () => {
    expect(one(RESULTS.balloons())).toMatchObject({ trait: 'risk', value: 0.5, weight: 2 });
    expect(one(RESULTS.balloons())!.evidence).toBe('Pumped 10 balloons 16 times on average before tying off (they could take up to 32). After one popped, you played it safer.');
  });

  it('coffee: learning (measured only) and following advice (obedience, weight 1)', () => {
    expect(one(RESULTS.coffee(), 'learning')).toMatchObject({ value: 0.8, weight: 1 });
    expect(one(RESULTS.coffee(), 'social')).toMatchObject({ value: 0.2, weight: 1 });
  });

  it('canteen: patience is the share of wait-for-more choices', () => {
    expect(one(RESULTS.canteen())).toMatchObject({ trait: 'patience', value: 0.75, weight: 2, graded: true });
    expect(one(RESULTS.canteen({ offers: 1, later_share: 1 }))!.graded).toBe(false);
  });

  it('renumbered: adaptability falls with perseverative errors', () => {
    expect(value(RESULTS.renumbered({ perseverative_errors: 0 }))).toBe(1);
    expect(value(RESULTS.renumbered())).toBe(0.5);
    expect(value(RESULTS.renumbered({ perseverative_errors: 3 }))).toBe(0.25);
  });

  it('pitch: calibration is 1 minus the confidence gap, either way', () => {
    expect(value(RESULTS.pitch())).toBe(0.7);
    expect(value(RESULTS.pitch({ overconfidence: -0.3 }))).toBe(0.7);
  });

  it('loan: trust (share lent) and trustworthiness (share returned), both measured only', () => {
    expect(one(RESULTS.loan(), 'trust')!.value).toBe(0.5);
    expect(one(RESULTS.loan(), 'trustworthiness')!.value).toBe(0.4);
    expect(one(RESULTS.loan({ trustworthiness: null }), 'trustworthiness')).toBeUndefined();
  });

  it('lockdown: coping with boredom is the share of the drill before pressing the button', () => {
    expect(value(RESULTS.lockdown())).toBe(0.333);
    expect(value(RESULTS.lockdown({ buzzer_presses: 0, time_to_first_buzz: null }))).toBe(1);
  });
});

describe('missing measurements', () => {
  it('null metrics give no measurement, never 0', () => {
    const allNull = (r: TaskResult): TaskResult => ({ ...r, metrics: Object.fromEntries(Object.keys(r.metrics).map((k) => [k, null])) });
    for (const make of Object.values(RESULTS)) expect(scoreTaskResult(allNull(make()))).toEqual([]);
    expect(scoreTaskResult({ ...RESULTS.lockdown(), metrics: {} })).toEqual([]); // lockdown reports {} when the doors never locked
    expect(value(RESULTS.meeting({ helped: null, help_under_pressure: null, abandoned_midway: null, came_back: null }))).toBeNull(); // never asked
    expect(value(RESULTS.smoke({ kept_on_task: null, raised_alarm: null }))).toBeNull(); // smoke never started
  });

  it('unknown tasks score nothing', () => {
    expect(scoreTaskResult({ ...RESULTS.lift(), task: 'mystery' })).toEqual([]);
  });

  it('a measurement missing from the average is not a 0 in it', () => {
    const ms = scoreTaskResults([RESULTS.lift(), RESULTS.canteen({ later_share: null })]);
    expect(combine(null, 0, ms.filter((x) => x.trait === 'patience'))).toEqual({ share: 0.5, n: 1 });
  });
});

/** A started run with only the task results given (no ordinary signals: no doors chosen, nothing inspected). */
function runWith(results: TaskResult[], ratings?: Record<SelfTrait, number | null>) {
  const run = new Run(7, gameData, { observeMs: 60_000 });
  run.start();
  run.taskResults.push(...results);
  if (ratings) run.selfRatings = ratings;
  return run;
}

describe('said / did with tasks', () => {
  it('task scores are real measurements, not estimates', () => {
    const m = measure(runWith([RESULTS.lift(), RESULTS.desk()]), gameData);
    expect(m.patience).toMatchObject({ score: 3, estimated: false, n: 1 }); // 47 s -> 0.5
    expect(m.exploration).toMatchObject({ score: 3.4, estimated: false, n: 1 });
    expect(m.patience.evidence).toBe('Waited 47 s for a lift that never came, pressing the button 3 times.');
    expect(m.risk.estimated).toBe(true); // nothing measured it
  });

  it('smoke without a crowd does not feed obedience', () => {
    const alone = measure(runWith([RESULTS.smoke({ crowd: 0 })]), gameData);
    const none = measure(runWith([RESULTS.lift()]), gameData);
    expect(alone.social).toEqual(none.social);
    expect(alone.social.estimated).toBe(true);
    const crowd = measure(runWith([RESULTS.smoke()]), gameData);
    expect(crowd.social).toMatchObject({ estimated: false, score: 5 });
  });

  it('a single yes/no observation is labelled and never a gap or the headline; one graded one can be', () => {
    const ratings = { risk: null, patience: 1, social: 1, exploration: null };
    const run = runWith([RESULTS.two_doors()], ratings);
    const m = measure(run, gameData);
    expect(m.social).toMatchObject({ score: 5, n: 1, oneObservation: true });
    const sd = compareSelf(m, ratings);
    const row = sd.rows.find((r) => r.trait === 'social')!;
    expect(row).toMatchObject({ did: 5, gap: null, oneObservation: true });
    expect(sd.headlineTrait).toBeNull();
    expect(sd.headline).toBe('There was not enough to compare.');

    const graded = runWith([RESULTS.lift({ seconds_waited: 95 })], ratings);
    const sd2 = compareSelf(measure(graded, gameData), ratings);
    expect(sd2.headlineTrait).toBe('patience');
    expect(sd2.headline).toBe("You said you aren't patient. Waited 95 s for a lift that never came, pressing the button 3 times.");

    // Two yes/no observations are enough.
    const two = runWith([RESULTS.two_doors(), RESULTS.smoke()], ratings);
    expect(compareSelf(measure(two, gameData), ratings).headlineTrait).toBe('social');
  });

  it('combines with ordinary signals at weight 1, and quotes the line that supports the headline', () => {
    const run = runWith([RESULTS.balloons({ adjusted_avg_pumps: 32 })], { risk: 1, patience: null, social: null, exploration: null });
    run.gambles.push({ room: 1, choice: 'safe', outcome: 'certain', timed: false, expired: false });
    const m = measure(run, gameData);
    // (0 x 1 + 1 x 2) / 3
    expect(m.risk).toMatchObject({ score: 3.7, n: 2, estimated: false, ordinaryShare: 0, evidence: 'You chose the certain door.' });
    const sd = compareSelf(m, { risk: 1, patience: null, social: null, exploration: null });
    expect(sd.headlineTrait).toBe('risk');
    // Said 1, did 4: the balloon line backs "more than you said", not the certain door.
    expect(sd.headline).toMatch(/^You said you don't take risks\. Pumped 10 balloons 32 times/);
  });

  it('an all-high player scores high and an all-low player low on every trait', () => {
    const high = runWith([
      RESULTS.two_doors(), RESULTS.lift({ seconds_waited: 95, self_rescue: 0 }), RESULTS.desk({ items_inspected: 1 }), RESULTS.meeting(),
      RESULTS.smoke(), RESULTS.balloons({ adjusted_avg_pumps: 30 }), RESULTS.coffee({ advice_reliance: 0 }), RESULTS.canteen({ later_share: 1 }),
      RESULTS.renumbered({ perseverative_errors: 0 }), RESULTS.pitch({ overconfidence: 0 }), RESULTS.loan({ initial_trust: 1, trustworthiness: 1 }),
      RESULTS.lockdown({ buzzer_presses: 0, time_to_first_buzz: null }),
    ]);
    const low = runWith([
      RESULTS.two_doors({ compliance: 0 }), RESULTS.lift({ seconds_waited: 3 }), RESULTS.desk({ items_inspected: 0 }),
      RESULTS.meeting({ helped: 0, help_under_pressure: 0 }), RESULTS.smoke({ kept_on_task: 0, raised_alarm: 1 }), RESULTS.balloons({ adjusted_avg_pumps: 2 }),
      RESULTS.coffee({ advice_reliance: 1 }), RESULTS.canteen({ later_share: 0 }), RESULTS.renumbered({ perseverative_errors: 5 }),
      RESULTS.pitch({ overconfidence: 0.9 }), RESULTS.loan({ initial_trust: 0, trustworthiness: 0 }), RESULTS.lockdown({ time_to_first_buzz: 3 }),
    ]);
    const hm = measure(high, gameData), lm = measure(low, gameData);
    // Coffee ties learning and obedience together (following the advice = not learning), so the
    // all-high player's coffee pick pulls obedience down a little: still 4+.
    for (const k of ['risk', 'patience', 'social', 'exploration'] as const) {
      expect(hm[k].estimated).toBe(false);
      expect(Math.round(hm[k].score), k).toBeGreaterThanOrEqual(4);
      expect(Math.round(lm[k].score), k).toBeLessThanOrEqual(2);
    }
    const ha = alsoMeasured(scoreTaskResults(high.taskResults)), la = alsoMeasured(scoreTaskResults(low.taskResults));
    expect(ha.map((a) => a.trait)).toEqual(['helpfulness', 'learning', 'adaptability', 'calibration', 'trust', 'trustworthiness', 'boredom']);
    for (const a of ha) expect(a.score, a.trait).toBeGreaterThanOrEqual(4);
    for (const a of la) expect(a.score, a.trait).toBeLessThanOrEqual(2);
  });
});

describe('the dossier', () => {
  it('with no task results, the dossier and said/did are identical to before the scoring layer', async () => {
    const golden = JSON.parse(readFileSync(new URL('./fixtures/no-tasks-golden.json', import.meta.url), 'utf8'));
    expect(await goldenOutput()).toEqual(golden);
  });

  it('with no task results, adds nothing new to the dossier', () => {
    const run = runWith([]);
    const d = buildDossier(run, templateVerdict(run), 'template', gameData);
    expect('taskMeasures' in d).toBe(false);
    expect('alsoMeasured' in d).toBe(false);
    for (const m of Object.values(d.measured)) {
      expect('tasks' in m).toBe(false);
      expect('oneObservation' in m).toBe(false);
    }
  });

  it('with task results: task lines per trait, measured-only traits, and every measurement', () => {
    const run = runWith([RESULTS.lift(), RESULTS.meeting(), RESULTS.smoke({ crowd: 0 })], { risk: 3, patience: 3, social: 3, exploration: 3 });
    const d = buildDossier(run, templateVerdict(run), 'template', gameData);
    expect(d.measured.patience.tasks!.map((x) => x.evidence)).toEqual(['Waited 47 s for a lift that never came, pressing the button 3 times.']);
    expect(d.alsoMeasured).toEqual([{ trait: 'helpfulness', label: 'Helpfulness', score: 5, n: 1, oneObservation: true, evidence: ["Stopped to fix a stranger's printer with 9 s left before your meeting."] }]);
    expect(d.taskMeasures!.map((x) => [x.task, x.trait, x.counts])).toEqual([['lift', 'patience', true], ['meeting', 'helpfulness', true], ['smoke', 'social', false]]);
  });
});

describe('telemetry', () => {
  function recorder() {
    const rows: TelemetryEvent[] = [];
    const ended: { profile: unknown }[] = [];
    const rec = new Recorder({ log: (e) => rows.push(e), end: (profile) => ended.push({ profile }), now: () => 0, inspectable: () => false });
    return { rec, rows, ended };
  }

  it('sends one task_measure event per measurement, with the raw metrics', () => {
    const { rec, rows } = recorder();
    rec.message({ type: 'task_result', result: RESULTS.coffee(), log: [] });
    rec.message({ type: 'task_result', result: { ...RESULTS.lockdown(), metrics: {} }, log: [] });
    expect(rows.map((r) => [r.type, r.trait, r.meta?.value, r.meta?.weight])).toEqual([
      ['task_measure', 'learning', 0.8, 1],
      ['task_measure', 'social', 0.2, 1],
      ['task_measure', null, null, null],
    ]);
    expect(rows[0]!.meta).toMatchObject({ task: 'coffee', version: 'office', task_room: 1, metrics: RESULTS.coffee().metrics });
    expect(rows[0]!.meta!.evidence).toBe('In your last five coffees, 4 came from a machine that pays off over time.');
  });

  it('stores per-trait scores, measurements, evidence and flags in sessions.profile', () => {
    const run = runWith([RESULTS.lift(), RESULTS.two_doors(), RESULTS.pitch()], { risk: 3, patience: 3, social: 3, exploration: 3 });
    const d = buildDossier(run, templateVerdict(run), 'template', gameData);
    const { rec, ended } = recorder();
    rec.message({ type: 'run_ended', dossier: d });
    const s = (ended[0]!.profile as { scoring: ReturnType<typeof scoring> }).scoring!;
    expect(s.traits.patience).toMatchObject({ score: 3, n: 1, not_tested: false, one_observation: false, ordinary: null });
    expect(s.traits.patience!.measurements).toEqual([expect.objectContaining({ task: 'lift', value: 0.5, weight: 2 })]);
    expect(s.traits.social).toMatchObject({ one_observation: true });
    expect(s.traits.risk).toMatchObject({ not_tested: true, measurements: [] });
    expect(s.also_measured).toEqual([expect.objectContaining({ trait: 'calibration', score: 3.8 })]);
    expect(s.task_measures).toHaveLength(3);
  });
});
