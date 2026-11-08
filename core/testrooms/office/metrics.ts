import type { TaskEvent } from '../../protocol';

/**
 * Shared measures for the office tasks (from PR #6, core/tasks/metrics.ts):
 * movement samples, robust z-scores, and the player's baseline from the
 * waiting room (walking speed, input rate, reaction time), so a task can
 * compare what the player does in it with how they behave normally.
 */

/** Speed below which the player counts as standing still (tiles per second). */
export const STILL = 0.1;
/** Speed above which a change of heading counts as a change of direction. */
const TURNING_SPEED = 0.3;
/** A change of heading larger than this, between two samples, is a change of direction. */
const TURN_ANGLE = Math.PI / 3;

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
const r2 = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

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

