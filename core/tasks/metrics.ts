import type { TaskEvent } from '../protocol';
import type { TaskId, TaskParams } from './params';

/**
 * Office task metrics (build spec, the "Metric / Formula" tables). Every
 * function here is a pure function of the event log, so any session can be
 * rescored or replayed later. Timing metrics are compared with the player's
 * own baseline from the first room, as robust z-scores.
 */

/** Speed below which the player counts as standing still (tiles per second). */
export const STILL = 0.1;
/** Speed above which a change of heading counts as a change of direction. */
const TURNING_SPEED = 0.3;
/** A change of heading larger than this, between two samples, is a change of direction. */
const TURN_ANGLE = Math.PI / 3;
/** Reading speed for "expected reading time", in words per minute. */
const WPM = 200;

export interface Sample { t: number; x: number; z: number; vx: number; vz: number; speed: number }

/** The player's own normal, from the first room (build spec "Baseline room"). */
export interface Baseline {
  /** Median walking speed while moving, tiles/s. */
  speed: number | null;
  speedMad: number | null;
  /** Key and button presses per second while moving. */
  inputRate: number | null;
  /** Share of time spent standing still. */
  idleShare: number | null;
  /** Distance walked plus key presses, per second, over the whole room: how much the player fidgets normally. */
  activity: number | null;
  /** Median time from an interaction prompt appearing to acting on it, seconds. */
  reaction: number | null;
  reactionMad: number | null;
  /** Direction changes per second while moving (median over one-second windows). */
  turns: number | null;
  turnsMad: number | null;
  samples: number;
}

// ---------- helpers ----------

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation. */
export function mad(xs: number[]): number | null {
  const m = median(xs);
  return m === null ? null : median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Robust z-score against the baseline: (x - median) / (1.4826 * MAD). With
 * only a few baseline observations the MAD can be zero, so the scale has a
 * floor (`minScale`, in the metric's own units).
 */
export function robustZ(x: number | null, med: number | null, madValue: number | null, minScale: number): number | null {
  if (x === null || med === null) return null;
  const scale = Math.max(1.4826 * (madValue ?? 0), minScale);
  return (x - med) / scale;
}

export function samples(events: TaskEvent[]): Sample[] {
  return events
    .filter((e) => e.type === 'move')
    .map((e) => {
      const d = e.data as { x: number; z: number; vx: number; vz: number };
      return { t: e.t, x: d.x, z: d.z, vx: d.vx, vz: d.vz, speed: Math.hypot(d.vx, d.vz) };
    });
}

/** Number of direction changes among moving samples in [from, to]. */
function turnCount(ss: Sample[], from: number, to: number): number {
  let n = 0;
  let prev: Sample | undefined;
  for (const s of ss) {
    if (s.t < from || s.t > to) continue;
    if (s.speed < TURNING_SPEED) { prev = undefined; continue; }
    if (prev) {
      const a = Math.atan2(s.vz, s.vx) - Math.atan2(prev.vz, prev.vx);
      const d = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
      if (d > TURN_ANGLE) n++;
    }
    prev = s;
  }
  return n;
}

function walked(ss: Sample[]): number {
  let d = 0;
  for (let i = 1; i < ss.length; i++) d += Math.hypot(ss[i]!.x - ss[i - 1]!.x, ss[i]!.z - ss[i - 1]!.z);
  return d;
}

const of = (events: TaskEvent[], type: string, pred: (d: Record<string, unknown>) => boolean = () => true) =>
  events.filter((e) => e.type === type && pred(e.data));
const first = (events: TaskEvent[], type: string, pred?: (d: Record<string, unknown>) => boolean) => of(events, type, pred)[0];
const r2 = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const s0 = (n: number) => `${Math.round(n)} s`;
const s1 = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)} s`;

// ---------- baseline ----------

export function computeBaseline(events: TaskEvent[]): Baseline {
  const ss = samples(events);
  const moving = ss.filter((s) => s.speed > STILL);
  let movingSeconds = 0;
  for (let i = 1; i < ss.length; i++) if (ss[i - 1]!.speed > STILL) movingSeconds += Math.min(0.5, ss[i]!.t - ss[i - 1]!.t);
  const inputs = of(events, 'input');
  const speedAt = (t: number) => {
    let s: Sample | undefined;
    for (const x of ss) if (x.t <= t) s = x; else break;
    return s?.speed ?? 0;
  };
  const movingInputs = inputs.filter((e) => speedAt(e.t) > STILL).length;

  // Reaction time: prompt on an object to the first E press (or click) aimed at it.
  const reactions: number[] = [];
  for (const p of of(events, 'prompt_shown')) {
    const target = p.data.prompt;
    const act = inputs.find((e) => e.t >= p.t && e.t - p.t <= 30 && e.data.target === target && (e.data.key === 'KeyE' || e.data.key === 'Mouse0'));
    if (act) reactions.push(act.t - p.t);
  }

  // Direction changes per second, in one-second windows that had some walking.
  const windows: number[] = [];
  if (ss.length) {
    for (let w = Math.floor(ss[0]!.t); w <= ss.at(-1)!.t; w++) {
      const inWin = ss.filter((s) => s.t >= w && s.t < w + 1);
      if (inWin.filter((s) => s.speed > TURNING_SPEED).length >= 4) windows.push(turnCount(ss, w, w + 0.999));
    }
  }
  const speeds = moving.map((s) => s.speed);
  const duration = ss.length > 1 ? ss.at(-1)!.t - ss[0]!.t : 0;
  return {
    speed: r2(median(speeds)),
    speedMad: r2(mad(speeds)),
    inputRate: movingSeconds >= 2 ? r2(movingInputs / movingSeconds) : null,
    idleShare: ss.length >= 20 ? r2(ss.filter((s) => s.speed < STILL).length / ss.length) : null,
    activity: duration >= 5 ? r2((walked(ss) + inputs.length) / duration) : null,
    reaction: r2(median(reactions)),
    reactionMad: r2(mad(reactions)),
    turns: r2(median(windows)),
    turnsMad: r2(mad(windows)),
    samples: ss.length,
  };
}

// ---------- tasks ----------

export interface ScoreContext {
  params: TaskParams;
  baseline: Baseline | null;
  /** The whole run's log, for metrics that look ahead (the desk note used later). */
  all: TaskEvent[];
}

export interface Score {
  metrics: Record<string, number | null>;
  notes: string[];
}

export function scoreTask(id: TaskId, events: TaskEvent[], ctx: ScoreContext): Score {
  return SCORERS[id](events, ctx);
}

const SCORERS: Record<TaskId, (events: TaskEvent[], ctx: ScoreContext) => Score> = {
  two_doors(ev, { params, baseline }) {
    const said = first(ev, 'narrator_start', (d) => d.line === 'instruction');
    const done = first(ev, 'narrator_end', (d) => d.line === 'instruction');
    const choice = first(ev, 'choice', (d) => d.prompt === 'door');
    const instructed = String(params.instructedSide);
    const forbidden = instructed === 'left' ? 'right' : 'left';
    const chosen = choice ? String(choice.data.chosen) : null;
    const compliance = chosen === null ? null : chosen === instructed ? 1 : 0;
    const latency = choice && done ? choice.t - done.t : null;
    const ss = samples(ev);
    let early: number | null = null;
    if (said && done && done.t > said.t) {
      // Share of the line during which the player was more than a tile from where they stood when it began.
      const at = [...ss].reverse().find((s) => s.t <= said.t) ?? ss.find((s) => s.t >= said.t);
      const cut = Math.min(done.t, choice?.t ?? done.t);
      const during = ss.filter((s) => s.t >= said.t && s.t <= cut);
      const share = at && during.length ? during.filter((s) => Math.hypot(s.x - at.x, s.z - at.z) > 1).length / during.length : 0;
      // Through the door before the line finished: the rest of the line counts as spent on the move.
      early = (share * (cut - said.t) + (done.t - cut)) / (done.t - said.t);
    }
    const approaches = of(ev, 'zone_enter', (d) => d.zone === `door_${forbidden}`).length;
    const metrics = {
      compliance,
      compliance_latency: r2(latency),
      compliance_latency_z: r2(robustZ(latency, baseline?.reaction ?? null, baseline?.reactionMad ?? null, 0.25)),
      early_action: r2(early),
      forbidden_approaches: approaches,
    };
    const notes: string[] = [];
    if (chosen) notes.push(`Told to take the ${instructed} door, you took the ${chosen} one${latency !== null ? `, ${latency >= 0 ? `${s1(latency)} after the instruction ended` : `${s1(-latency)} before the instruction had even finished`}` : ''}.`);
    if (early !== null && early > 0.05) notes.push(`You were already on the move for ${Math.round(early * 100)}% of the instruction.`);
    if (approaches) notes.push(`You walked up to the ${forbidden}-hand maintenance door ${approaches === 1 ? 'once' : `${approaches} times`}.`);
    return { metrics, notes };
  },

  lift(ev, { params, baseline }) {
    const start = first(ev, 'task_start');
    const end = first(ev, 'task_end');
    const presses = of(ev, 'interact', (d) => d.action === 'press' && d.object === params.callProp).map((e) => e.t);
    const firstPress = presses[0];
    let peak = 0;
    for (const t of presses) peak = Math.max(peak, presses.filter((x) => x >= t && x < t + 5).length);
    const peakRate = presses.length && baseline?.inputRate ? peak / 5 / baseline.inputRate : null;
    const stairs = of(ev, 'zone_enter', (d) => d.zone === 'stairs');
    const pivotAt = firstPress === undefined ? undefined : stairs.find((e) => e.t >= firstPress);
    const pivot = firstPress !== undefined && pivotAt ? pivotAt.t - firstPress : null;
    const leftAt = stairs[0]?.t ?? end?.t;
    const waitFrom = firstPress ?? start?.t;
    let restless: number | null = null;
    if (waitFrom !== undefined && leftAt !== undefined && leftAt - waitFrom >= 3) {
      const rate = turnCount(samples(ev), waitFrom, leftAt) / (leftAt - waitFrom);
      restless = robustZ(rate, baseline?.turns ?? null, baseline?.turnsMad ?? null, 0.5);
    }
    const hint = first(ev, 'narrator_start', (d) => d.line === 'hint');
    const selfRescue = leftAt === undefined ? null : !hint || leftAt < hint.t ? 1 : 0;
    const waited = start && leftAt !== undefined ? leftAt - start.t : null;
    const metrics = {
      button_presses: presses.length,
      peak_press_rate: r2(peakRate),
      time_to_pivot: r2(pivot),
      restlessness: r2(restless),
      self_rescue: selfRescue,
      seconds_waited: r2(waited),
    };
    const notes: string[] = [];
    if (presses.length) {
      const span = presses.length > 1 ? presses.at(-1)! - presses[0]! : 0;
      notes.push(`You pressed the lift button ${presses.length === 1 ? 'once' : `${presses.length} times${span >= 1 ? ` in ${s0(span)}` : ''}`}.`);
    } else notes.push('You never pressed the lift button.');
    if (pivot !== null) notes.push(`You gave up on the lift and went for the stairs ${s0(pivot)} after first calling it${selfRescue ? ', before anyone suggested it' : ', once the narrator suggested it'}.`);
    else if (waited !== null && !presses.length) notes.push(`You went straight for the stairs, ${s0(waited)} after arriving.`);
    if (restless !== null && Math.abs(restless) >= 1) notes.push(restless > 0 ? 'While you waited, you paced more than you usually move.' : 'While you waited, you stood calmer than usual.');
    return { metrics, notes };
  },

  desk(ev, { params, baseline, all }) {
    const start = first(ev, 'task_start');
    const end = first(ev, 'task_end');
    const items = String(params.itemProps ?? '').split(',').filter(Boolean);
    const opened = new Set(of(ev, 'interact', (d) => d.action === 'inspect' && items.includes(String(d.object))).map((e) => String(e.data.object)));
    const dwell = start && end ? end.t - start.t : null;
    const shortest = Number(params.shortest) || null;
    const extra = dwell !== null && shortest && baseline?.speed ? dwell - shortest / baseline.speed : null;
    const pathRatio = shortest ? walked(samples(ev)) / shortest : null;
    let read = 0, expected = 0;
    for (const id of opened) {
      const words = Number(params[`words_${id}`]);
      if (!words) continue;
      expected += (words / WPM) * 60;
      read += of(ev, 'interact', (d) => d.action === 'inspect_close' && d.object === id).reduce((a, e) => a + Number(e.data.seconds ?? 0), 0);
    }
    const reading = expected ? read / expected : null;
    // Follow-through: the note names a door in a later room; did they use it?
    const later = first(all, 'choice', (d) => d.prompt === 'door' && d.secretOffered === true);
    const usedSecret = later ? (later.data.chosen === 'secret' ? 1 : 0) : null;
    const noteRead = opened.has('t_sticky');
    const metrics = {
      items_inspected: items.length ? r2(opened.size / items.length) : null,
      extra_time: r2(extra),
      path_ratio: r2(pathRatio),
      reading_depth: r2(reading),
      follow_through: noteRead ? usedSecret : null,
      used_secret_door: usedSecret,
    };
    const notes: string[] = [];
    notes.push(opened.size ? `You looked at ${opened.size} of the ${items.length} things on and around the desk.` : `You walked past the desk without looking at any of its ${items.length} things.`);
    if (extra !== null && extra > 3) notes.push(`You spent ${s0(extra)} longer in that corridor than walking straight through takes you.`);
    if (reading !== null) notes.push(reading >= 0.8 ? `You read what you opened properly (${Math.round(reading * 100)}% of the time it takes to read).` : `You skimmed what you opened (${Math.round(reading * 100)}% of the time it takes to read).`);
    if (noteRead && usedSecret !== null) notes.push(usedSecret ? 'You found the note about door 417, and later you used it.' : 'You found the note about door 417, and later walked past that door.');
    return { metrics, notes };
  },

  meeting(ev, { params }) {
    const start = first(ev, 'task_start');
    const asked = first(ev, 'prompt_shown', (d) => d.prompt === 'help');
    const starts = of(ev, 'interact', (d) => d.action === 'hold_start');
    const done = first(ev, 'interact', (d) => d.action === 'hold_end' && d.completed === true);
    const farEnd = first(ev, 'zone_enter', (d) => d.zone === 'far_end');
    const helped = done ? 1 : 0;
    const countdown = Number(params.countdown) || 13;
    const leftOnClock = (t: number) => (start ? Math.max(0, countdown - (t - start.t)) : null);
    const firstStart = starts[0];
    const cameBack = firstStart && farEnd && farEnd.t < firstStart.t ? 1 : 0;
    const visits = of(ev, 'zone_enter', (d) => d.zone === 'colleague').length;
    const metrics = {
      helped: asked ? helped : null,
      help_under_pressure: asked ? helped : null,
      // Needs the relaxed repeat (same request, no countdown) in a later level; not in the office yet.
      pressure_effect: null,
      abandoned_midway: asked ? (starts.length && !done ? 1 : 0) : null,
      came_back: asked ? cameBack : null,
      return_visits: Math.max(0, visits - 1),
      clock_at_help: firstStart ? r2(leftOnClock(firstStart.t)) : null,
    };
    const notes: string[] = [];
    if (!asked) notes.push('You never went near the colleague at the printer.');
    else if (done) notes.push(`With ${s0(leftOnClock(firstStart!.t) ?? 0)} on the clock, you stopped to fix a stranger's printer${cameBack ? ', after first walking past them' : ''}.`);
    else if (starts.length) notes.push('You started helping with the printer, then left halfway.');
    else notes.push('Asked for help on your way to the meeting, you kept walking.');
    return { metrics, notes };
  },

  smoke(ev, { params }) {
    const smoke = first(ev, 'smoke_start');
    const crowd = params.condition !== 'alone';
    const reactions = smoke
      ? [
          ...of(ev, 'interact', (d) => d.action === 'alarm').map((e) => ({ t: e.t, kind: 'alarm' })),
          ...of(ev, 'interact', (d) => d.action === 'talk').map((e) => ({ t: e.t, kind: 'talk' })),
          ...of(ev, 'zone_enter', (d) => d.zone === 'vent').map((e) => ({ t: e.t, kind: 'vent' })),
          ...of(ev, 'zone_enter', (d) => d.zone === 'fire_exit').map((e) => ({ t: e.t, kind: 'exit' })),
          ...of(ev, 'choice', (d) => d.prompt === 'door').map((e) => ({ t: e.t, kind: 'exit' })),
        ].filter((r) => r.t >= smoke.t).sort((a, b) => a.t - b.t)
      : [];
    const react = reactions[0];
    const pickup = first(ev, 'interact', (d) => d.action === 'pickup');
    const alarm = first(ev, 'interact', (d) => d.action === 'alarm');
    const latency = smoke && react ? react.t - smoke.t : null;
    const metrics = {
      reaction_latency: r2(latency),
      raised_alarm: smoke ? (alarm ? 1 : 0) : null,
      kept_on_task: smoke ? (pickup && (!react || pickup.t < react.t) ? 1 : 0) : null,
      social_check: smoke && crowd ? (react?.kind === 'talk' ? 1 : 0) : null,
      crowd: crowd ? 1 : 0,
    };
    const what: Record<string, string> = { alarm: 'pull the alarm', talk: 'ask someone about it', vent: 'go and look at the vent', exit: 'head for the exit' };
    const notes: string[] = [];
    if (!smoke) notes.push('You left before anything happened.');
    else if (react) notes.push(`When the smoke started${crowd ? ' and nobody else moved' : ''}, it took you ${s0(latency!)} to ${what[react.kind]}.`);
    if (smoke) notes.push(alarm ? 'You pulled the fire alarm.' : 'You never pulled the fire alarm.');
    if (pickup) notes.push(metrics.kept_on_task ? 'You fetched the file first.' : 'You still went back for the file.');
    return { metrics, notes };
  },
};
