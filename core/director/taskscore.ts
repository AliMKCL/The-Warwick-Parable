import type { AlsoMeasured, MeasuredOnlyTrait, SelfTrait, TaskMeasure, TaskResult, TaskTrait } from '../protocol';

/**
 * Task scoring: turns each office task's result (TaskResult, as the tasks
 * report it) into one value between 0 and 1 for the trait it measures.
 *
 * The table below is the whole of it. Each entry is one task: which trait(s)
 * it feeds, a rule from its metrics to 0..1, a weight, and an evidence line.
 * Adding a task means adding one entry. Docs: docs/scoring.md.
 *
 * Rules return null when a metric they need is null or missing: that is "no
 * measurement", never 0. The slider traits use their code names: social is
 * "I do what I'm told" (obedience), exploration is "I explore everything"
 * (curiosity).
 */

type Metrics = Record<string, number | null>;
type Params = TaskResult['params'];

export interface TraitRule {
  trait: TaskTrait;
  /** Weight in the trait's average. Ordinary signals (a gamble, a countdown...) weigh 1. */
  weight: number;
  /** 0..1 (higher = more of the trait), or null when there is nothing to score. */
  value(m: Metrics, p: Params): number | null;
  /** Whether the value can fall between the ends, or is a single yes/no moment. */
  graded: boolean | ((m: Metrics, p: Params) => boolean);
  /** One sentence for the dossier, built from the metrics. */
  evidence(m: Metrics, p: Params, value: number): string;
  /** Recorded but not scored when this returns false (the evidence still goes to the database). */
  counts?: (m: Metrics, p: Params) => boolean;
}

export interface TaskEntry {
  /** Task id as reported in TaskResult.task. */
  id: string;
  /** Number in "Psychometric Game Tasks: Build Spec". */
  number: string;
  name: string;
  /** Settings it comes in; every version is scored the same way and the version is recorded. */
  versions: readonly ('office' | 'mine')[];
  /** 'ready': metrics exist and are scored. 'pending': the rule is planned but the task reports nothing yet. */
  status: 'ready' | 'pending';
  /** Research the measure is based on (also in docs/scoring.md). */
  basis: string;
  rules: TraitRule[];
}

/**
 * Lift: seconds waited for a lift that never comes, in bands. PROVISIONAL:
 * guessed, not calibrated. Re-set these from real player data (tools/analyze.ts
 * prints every lift's seconds_waited). Waiting until the narrator's hint
 * (params.timeout, 90 s) always scores 1.
 */
export const LIFT_PATIENCE_BANDS: readonly { under: number; value: number }[] = [
  { under: 10, value: 0 },
  { under: 30, value: 0.25 },
  { under: 60, value: 0.5 },
  { under: Infinity, value: 0.75 },
];

const BOTH = ['office', 'mine'] as const;

/** A finite number, or null. Every rule reads metrics through this. */
const num = (m: Metrics, k: string): number | null => {
  const v = m[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const s0 = (n: number) => `${Math.round(n)} s`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const times = (k: number) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`);

export const TASKS: TaskEntry[] = [
  // ---------- tasks 1 to 5 (core/tasks/metrics.ts) ----------
  {
    id: 'two_doors',
    number: '1',
    name: 'Two Doors',
    versions: BOTH,
    status: 'ready',
    basis: 'Brehm (1966) psychological reactance: a forbidden option becomes more attractive.',
    rules: [{
      trait: 'social',
      weight: 2,
      graded: false,
      value(m) {
        const c = num(m, 'compliance');
        if (c === null) return null;
        if (c === 0) return 0;
        return (num(m, 'forbidden_approaches') ?? 0) > 0 ? 0.5 : 1;
      },
      evidence(m, p, v) {
        const told = p.instructedSide ? `the ${p.instructedSide} door` : 'one door';
        const lat = num(m, 'compliance_latency');
        const when = lat === null ? '' : lat >= 0 ? `, ${s0(lat)} after the instruction ended` : `, before the instruction had even finished`;
        if (v === 0) return `Told to take ${told}, you took the other one${when}.`;
        const near = num(m, 'forbidden_approaches') ?? 0;
        return `Told to take ${told}, you did${when}${v === 0.5 ? `, after walking up to the forbidden one ${times(near)}` : ''}.`;
      },
    }],
  },
  {
    id: 'lift',
    number: '2',
    name: 'The Lift That Never Comes',
    versions: BOTH,
    status: 'ready',
    basis: 'Frustration tolerance: persistence at a blocked goal (Amsel 1958; Harrington 2005).',
    rules: [{
      trait: 'patience',
      weight: 2,
      graded: true,
      value(m, p) {
        const waited = num(m, 'seconds_waited');
        if (waited === null) return null;
        const hint = Number(p.timeout) || 90;
        // Still there when the narrator gave the hint (self_rescue 0), or waited at least that long.
        if (num(m, 'self_rescue') === 0 || waited >= hint) return 1;
        return LIFT_PATIENCE_BANDS.find((b) => waited < b.under)!.value;
      },
      evidence(m) {
        const waited = num(m, 'seconds_waited')!;
        const presses = num(m, 'button_presses');
        const restless = num(m, 'restlessness');
        const parts = [`Waited ${s0(waited)} for a lift that never came`];
        if (presses !== null) parts.push(presses ? `pressing the button ${times(presses)}` : 'without pressing the button');
        if (restless !== null && Math.abs(restless) >= 1) parts.push(restless > 0 ? 'pacing more than you usually move' : 'standing calmer than usual');
        return `${parts.join(', ')}.`;
      },
    }],
  },
  {
    id: 'desk',
    number: '3',
    name: 'The Abandoned Desk',
    versions: BOTH,
    status: 'ready',
    basis: 'Need for cognition (Cacioppo & Petty 1982): seeking out information nobody asked you to read.',
    rules: [{
      trait: 'exploration',
      weight: 2,
      graded: true,
      value: (m) => { const v = num(m, 'items_inspected'); return v === null ? null : clamp01(v); },
      evidence(m, p, v) {
        const total = String(p.itemProps ?? '').split(',').filter(Boolean).length || Number(p.items) || 0;
        const seen = total ? `${Math.round(v * total)} of the ${total} things` : `${pct(v)} of the things`;
        if (v === 0) return total ? `Walked past the abandoned desk without looking at any of its ${total} things.` : 'Walked past the abandoned desk without looking at anything on it.';
        const depth = num(m, 'reading_depth');
        return `Looked at ${seen} on the abandoned desk${depth === null ? '' : depth >= 0.8 ? ', and read them properly' : ', skimming what you opened'}.`;
      },
    }],
  },
  {
    id: 'meeting',
    number: '4',
    name: 'Late for the Meeting',
    versions: BOTH,
    status: 'ready',
    basis: 'Darley & Batson (1973), "From Jerusalem to Jericho": helping drops when people are in a hurry.',
    rules: [{
      trait: 'helpfulness',
      weight: 1,
      graded: false,
      value(m) {
        const helped = num(m, 'helped');
        if (helped === null) return null; // never asked: nothing measured
        if (helped === 1) return 1;
        if (num(m, 'abandoned_midway') === 1 || num(m, 'came_back') === 1) return 0.5;
        return 0;
      },
      evidence(m, _p, v) {
        const clock = num(m, 'clock_at_help');
        if (v === 1) return `Stopped to fix a stranger's printer${clock === null ? '' : ` with ${s0(clock)} left before your meeting`}.`;
        if (v === 0.5) return num(m, 'abandoned_midway') === 1 ? 'Started helping with the printer, then left halfway.' : 'Walked past the colleague at the printer, then came back.';
        return 'Asked for help on your way to the meeting, you kept walking.';
      },
    }],
  },
  {
    id: 'smoke',
    number: '5',
    name: 'The Smoky Corridor',
    versions: BOTH,
    status: 'ready',
    basis: 'Latané & Darley (1968): people react to smoke more slowly when others around them do nothing.',
    rules: [{
      // Reversed: carrying on like the others is going along with the room.
      trait: 'social',
      weight: 2,
      graded: false,
      counts: (m) => num(m, 'crowd') === 1,
      value(m) {
        const kept = num(m, 'kept_on_task');
        if (kept === null) return null; // the smoke never started
        if (num(m, 'raised_alarm') === 1) return 0;
        return kept === 1 ? 1 : 0;
      },
      evidence(m, _p, v) {
        const alone = num(m, 'crowd') !== 1;
        const what = num(m, 'raised_alarm') === 1 ? 'pulled the fire alarm' : v === 1 ? 'carried on fetching the file' : 'acted on the smoke before fetching the file';
        if (alone) return `Alone in the smoky corridor, you ${what}. (Recorded only: with nobody else there, this says nothing about going along with others.)`;
        return `When smoke filled the corridor and your colleagues carried on, you ${what}. This measures going along with others, not following instructions.`;
      },
    }],
  },

  // ---------- tasks 6 to 11 (core/tasks/office/*, office versions; mine versions to come) ----------
  {
    id: 'balloons',
    number: '6',
    name: 'Risk: party balloons (mine: ore drill)',
    versions: BOTH,
    status: 'ready',
    basis: 'Lejuez et al. (2002), Balloon Analogue Risk Task: average pumps on balloons that did not pop.',
    rules: [{
      trait: 'risk',
      weight: 2,
      graded: true,
      value(m, p) {
        const avg = num(m, 'adjusted_avg_pumps');
        return avg === null ? null : clamp01(avg / (Number(p.maxPumps) || 32));
      },
      evidence(m, p) {
        const avg = num(m, 'adjusted_avg_pumps')!;
        const n = num(m, 'balloons');
        const shift = num(m, 'post_loss_shift');
        const after = shift === null || Math.abs(shift) < 2 ? '' : shift > 0 ? ' After one popped, you pumped harder.' : ' After one popped, you played it safer.';
        return `Pumped ${n === null ? 'the' : n} balloon${n === 1 ? '' : 's'} ${Math.round(avg)} times on average before tying off (they could take up to ${Number(p.maxPumps) || 32}).${after}`;
      },
    }],
  },
  {
    id: 'coffee',
    number: '7',
    name: 'Learning: coffee machines (mine: tunnels)',
    versions: BOTH,
    status: 'ready',
    basis: 'Bechara et al. (1994), Iowa Gambling Task: learning to leave the option that loses in the long run.',
    rules: [
      {
        // The recommended machine is the bad one, so the later picks from the others are the good ones.
        trait: 'learning',
        weight: 1,
        graded: true,
        value: (m) => { const r = num(m, 'advice_reliance'); return r === null ? null : clamp01(1 - r); },
        evidence: (_m, _p, v) => `In your last five coffees, ${Math.round(v * 5)} came from a machine that pays off over time.`,
      },
      {
        trait: 'social',
        weight: 1,
        graded: true,
        value: (m) => { const r = num(m, 'advice_reliance'); return r === null ? null : clamp01(r); },
        evidence: (_m, _p, v) => `${Math.round(v * 5)} of your last five coffees came from the machine you were told to use, spills and all.`,
      },
    ],
  },
  {
    id: 'canteen',
    number: '8',
    name: 'Patience: canteen queue (mine: lamp oil)',
    versions: BOTH,
    status: 'ready',
    basis: 'Delay discounting (Mazur 1987; Kirby & Maraković 1996): a smaller reward now or a bigger one later.',
    rules: [{
      trait: 'patience',
      weight: 2,
      graded: (m) => (num(m, 'offers') ?? 0) > 1,
      value: (m) => num(m, 'later_share'),
      evidence(m) {
        const n = num(m, 'offers') ?? 0;
        const later = Math.round((num(m, 'later_share') ?? 0) * n);
        const gaveUp = num(m, 'abandon_rate');
        return `At the canteen you chose to wait for the better food ${later} of ${n} time${n === 1 ? '' : 's'}${gaveUp ? ', though you gave up on the queue at least once' : ''}.`;
      },
    }],
  },
  {
    id: 'renumbered',
    number: '9',
    name: 'Adaptability: renumbered floor (mine: chalk arrows)',
    versions: BOTH,
    status: 'ready',
    basis: 'Wisconsin Card Sorting Test (Grant & Berg 1948; Heaton 1981): perseverative errors after a rule change.',
    rules: [{
      trait: 'adaptability',
      weight: 1,
      graded: true,
      // 0 errors = 1, 1 = 0.5, 2 = 0.33... (the number of junctions after the switch varies, so no fixed maximum).
      value: (m) => { const e = num(m, 'perseverative_errors'); return e === null ? null : 1 / (1 + e); },
      evidence(m) {
        const e = num(m, 'perseverative_errors')!;
        const adapt = num(m, 'junctions_to_adapt');
        const back = adapt === null ? 'you never quite found your bearings' : `you were back on track within ${adapt} turns`;
        return `After the floor was renumbered ${back}${e ? `, trusting the old signs ${times(e)} after they had misled you` : ''}.`;
      },
    }],
  },
  {
    id: 'pitch',
    number: '10a',
    name: 'Calibration: the pitch (mine: cart jump)',
    versions: BOTH,
    status: 'ready',
    basis: 'Confidence calibration (Lichtenstein, Fischhoff & Phillips 1982; Moore & Healy 2008).',
    rules: [{
      trait: 'calibration',
      weight: 1,
      graded: true,
      value: (m) => { const o = num(m, 'overconfidence'); return o === null ? null : clamp01(1 - Math.abs(o)); },
      evidence(m) {
        const conf = num(m, 'mean_confidence'), hit = num(m, 'success_rate'), n = num(m, 'pitches');
        if (conf === null || hit === null) return 'Gave a pitch.';
        return `Said you were ${pct(conf)} sure on average, and landed ${pct(hit)} of ${n ?? 'your'} pitch${n === 1 ? '' : 'es'}.`;
      },
    }],
  },
  {
    id: 'loan',
    number: '10b',
    name: 'Trust: token loan (mine: stranded miner)',
    versions: BOTH,
    status: 'ready',
    basis: 'Berg, Dickhaut & McCabe (1995), the trust game: how much you send, and how much you return.',
    rules: [
      {
        trait: 'trust',
        weight: 1,
        graded: true,
        value: (m) => { const v = num(m, 'initial_trust'); return v === null ? null : clamp01(v); },
        evidence: (_m, p, v) => `Lent a colleague ${Math.round(v * (Number(p.endowment) || 10))} of your ${Number(p.endowment) || 10} coffee tokens.`,
      },
      {
        trait: 'trustworthiness',
        weight: 1,
        graded: true,
        value: (m) => { const v = num(m, 'trustworthiness'); return v === null ? null : clamp01(v); },
        evidence: (_m, _p, v) => `Trusted with someone else's tokens, you gave back ${pct(v)} of what you received.`,
      },
    ],
  },
  {
    id: 'lockdown',
    number: '11',
    name: 'Coping with boredom: lockdown drill',
    versions: ['office'],
    status: 'ready',
    basis: 'Wilson et al. (2014), "Just think": many people would rather shock themselves than sit alone with their thoughts.',
    rules: [{
      trait: 'boredom',
      weight: 1,
      graded: true,
      value(m) {
        const lock = num(m, 'lock_seconds');
        if (lock === null || lock <= 0) return null;
        const first = num(m, 'time_to_first_buzz');
        if (first === null) return (num(m, 'buzzer_presses') ?? 0) > 0 ? null : 1; // never pressed: lasted the whole drill
        return clamp01(first / lock);
      },
      evidence(m) {
        const lock = num(m, 'lock_seconds')!;
        const first = num(m, 'time_to_first_buzz');
        const presses = num(m, 'buzzer_presses') ?? 0;
        return first === null
          ? `Locked in for ${s0(lock)}, you never pressed the button you were told not to press.`
          : `Locked in for ${s0(lock)}, you pressed the button you were told not to press after ${s0(first)}${presses > 1 ? `, ${presses} times in all` : ''}.`;
      },
    }],
  },
];

export const TASK_TABLE: Record<string, TaskEntry> = Object.fromEntries(TASKS.map((t) => [t.id, t]));

/** How measured-only traits are named in the dossier. */
export const MEASURED_ONLY_LABELS: Record<MeasuredOnlyTrait, string> = {
  helpfulness: 'Helpfulness',
  learning: 'Learning from losses',
  adaptability: 'Adapting when the rules change',
  calibration: 'Knowing how good you are',
  trust: 'Trust in others',
  trustworthiness: 'Paying trust back',
  boredom: 'Coping with boredom',
};
export const MEASURED_ONLY: MeasuredOnlyTrait[] = Object.keys(MEASURED_ONLY_LABELS) as MeasuredOnlyTrait[];
export const isSelfTrait = (t: TaskTrait): t is SelfTrait => t === 'risk' || t === 'patience' || t === 'social' || t === 'exploration';

/** Every measurement one task result gives (none for an unknown or pending task, or when its metrics are null). */
export function scoreTaskResult(r: TaskResult): TaskMeasure[] {
  const entry = TASK_TABLE[r.task];
  if (!entry || entry.status !== 'ready') return [];
  const metrics = r.metrics ?? {};
  const params = r.params ?? {};
  const out: TaskMeasure[] = [];
  for (const rule of entry.rules) {
    const raw = rule.value(metrics, params);
    if (raw === null || !Number.isFinite(raw)) continue;
    const value = Math.round(clamp01(raw) * 1000) / 1000;
    out.push({
      task: r.task,
      version: r.version ?? 'office',
      room: r.room,
      trait: rule.trait,
      value,
      weight: rule.weight,
      graded: typeof rule.graded === 'function' ? rule.graded(metrics, params) : rule.graded,
      counts: rule.counts ? rule.counts(metrics, params) : true,
      evidence: rule.evidence(metrics, params, value),
      metrics: { ...metrics },
    });
  }
  return out;
}

export function scoreTaskResults(results: readonly TaskResult[]): TaskMeasure[] {
  return results.flatMap(scoreTaskResult);
}

/**
 * Combines ordinary signals and task measurements into one share (0..1):
 * a weighted average where each ordinary signal weighs 1 (`legacyShare` over
 * `legacyN` of them) and each task measurement its own weight.
 */
export function combine(legacyShare: number | null, legacyN: number, measures: readonly TaskMeasure[]): { share: number; n: number } | null {
  const counted = measures.filter((x) => x.counts);
  const legacyW = legacyShare === null ? 0 : legacyN;
  const w = legacyW + counted.reduce((a, x) => a + x.weight, 0);
  if (!w) return null;
  const sum = (legacyShare ?? 0) * legacyW + counted.reduce((a, x) => a + x.value * x.weight, 0);
  return { share: sum / w, n: legacyW + counted.length };
}

/** The traits with no slider, 1–5, from the tasks that measured them (in table order). */
export function alsoMeasured(measures: readonly TaskMeasure[]): AlsoMeasured[] {
  return MEASURED_ONLY.flatMap((trait) => {
    const xs = measures.filter((x) => x.trait === trait && x.counts);
    const c = combine(null, 0, xs);
    if (!c) return [];
    return [{
      trait,
      label: MEASURED_ONLY_LABELS[trait],
      score: Math.round((1 + 4 * clamp01(c.share)) * 10) / 10,
      n: c.n,
      oneObservation: c.n === 1 && !xs[0]!.graded,
      evidence: xs.map((x) => x.evidence),
    }];
  });
}
