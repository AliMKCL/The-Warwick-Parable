import type { Profile } from './profile';
import { distanceAt, type RoomFields } from '../room/fields';
import type { RoomSpec } from '../room/types';

/**
 * Reads how the player walked through a room, from the 10 Hz position samples
 * and the room's distance fields (core/room/fields.ts). Every sample is a few
 * table lookups, no path-finding.
 *
 * - Approach and retreat: walking up to a door (within NEAR metres of walking
 *   distance) and then away from it again (by RETREAT metres) is a reversal,
 *   the clearest sign of second thoughts at a door.
 * - Commit time: the last moment from which the player kept closing in on the
 *   door they finally took, without stopping. Before it they were deciding
 *   (standing, wandering, trying other doors); after it, going.
 * - Efficiency: shortest route to the chosen door ÷ the distance walked.
 * - Coverage: the share of the reachable floor they set foot on.
 */

const NEAR = 2.2;
const RETREAT = 1.6;
/** Slack before closing in on a door counts as broken (sample noise, sidestepping a chair). */
const SLACK = 0.35;
/** A jump larger than this between samples is a teleport or a cut, not walking. */
const JUMP = 2.5;
/** Standing still this long ends any run of closing in: committing means setting off. */
const PAUSE = 1.5;
/** Moving less than this between samples (0.3 m/s at 10 Hz) is standing still. */
const STILL_STEP = 0.03;
/** Fewer samples than this and there is nothing to read (tests, or the player never moved). */
const MIN_SAMPLES = 15;

export interface DoorPath {
  door: string;
  label: string;
  /** Times the player walked up to this door and turned away. */
  reversals: number;
  /** Closest the player came, metres of walking distance. */
  closest: number;
}

export interface PathStats {
  room: number;
  samples: number;
  /** Metres walked in the room. */
  walked: number;
  /** Shortest route from the spawn to the chosen door. */
  shortest?: number;
  /** shortest ÷ walked (1 = a straight line to the door). */
  efficiency?: number;
  /** Share of the reachable floor visited, 0–1. */
  coverage: number;
  doors: DoorPath[];
  reversals: number;
  /** Doors the player walked up to (including the one they took). */
  approached: number;
  chosen?: string;
  /** Seconds from entering to committing to the chosen door. */
  deliberation?: number;
  /** Seconds from committing to walking through it. */
  commit?: number;
}

interface DoorState {
  near: boolean;
  min: number;
  reversals: number;
  closest: number;
  /** Start of the current run of closing in, and the distance it has got down to. */
  runStart: number;
  runMin: number;
}

export class PathTracker {
  private doors = new Map<string, DoorState>();
  private visited = new Set<number>();
  private prev?: { x: number; z: number; t: number };
  private walked = 0;
  private samples = 0;
  private lastMoved: number;

  constructor(
    readonly room: RoomSpec,
    readonly fields: RoomFields,
    private readonly entered: number,
  ) {
    this.lastMoved = entered;
    for (const id of Object.keys(fields.exits)) this.doors.set(id, { near: false, min: Infinity, reversals: 0, closest: Infinity, runStart: entered, runMin: Infinity });
  }

  move(x: number, z: number, t: number): void {
    const cx = Math.floor(x), cz = Math.floor(z);
    // Outside the room's grid (a connecting corridor): not part of this room's path.
    if (cx < 0 || cz < 0 || cx >= this.fields.width || cz >= this.fields.depth) { this.prev = undefined; return; }
    if (this.prev) {
      const step = Math.hypot(x - this.prev.x, z - this.prev.z);
      if (step < JUMP) this.walked += step;
      if (step >= STILL_STEP) this.lastMoved = t;
    }
    const paused = t - this.lastMoved >= PAUSE;
    this.prev = { x, z, t };
    this.samples++;
    this.visited.add(cz * this.fields.width + cx);
    for (const [id, s] of this.doors) {
      const d = distanceAt(this.fields.exits[id]!, x, z);
      if (d === Infinity) continue;
      s.closest = Math.min(s.closest, d);
      // Approach / retreat with hysteresis.
      if (d < NEAR) { s.near = true; s.min = Math.min(s.min, d); }
      else if (s.near && d > s.min + RETREAT) { s.reversals++; s.near = false; s.min = Infinity; }
      // Commitment: a run of never moving away (beyond the slack) from this door.
      if (paused || d > s.runMin + SLACK) { s.runStart = t; s.runMin = d; }
      else s.runMin = Math.min(s.runMin, d);
    }
  }

  /** The player left through `doorId` at `t`. */
  finish(doorId: string | undefined, t: number): PathStats {
    const doors = [...this.doors].map(([door, s]) => ({
      door,
      label: this.room.layout.doors.find((d) => d.id === door)?.label ?? door,
      reversals: s.reversals,
      closest: round(s.closest),
    }));
    const chosen = doorId ? this.doors.get(doorId) : undefined;
    const shortest = doorId ? this.fields.shortest[doorId] : undefined;
    const out: PathStats = {
      room: this.room.index,
      samples: this.samples,
      walked: round(this.walked),
      coverage: round(this.visited.size / Math.max(1, this.fields.reachableCells)),
      doors,
      reversals: doors.reduce((a, d) => a + d.reversals, 0),
      approached: [...this.doors.values()].filter((s) => s.closest < NEAR).length,
      ...(doorId ? { chosen: doorId } : {}),
    };
    if (shortest !== undefined && Number.isFinite(shortest)) {
      out.shortest = round(shortest);
      if (this.walked > 0.5) out.efficiency = round(Math.min(1, shortest / this.walked));
    }
    if (chosen) {
      out.deliberation = round(Math.max(0, chosen.runStart - this.entered));
      out.commit = round(Math.max(0, t - chosen.runStart));
    }
    return out;
  }
}

/** Enough samples to say anything. */
export function readable(p: PathStats): boolean {
  return p.samples >= MIN_SAMPLES;
}

/** Profile evidence from a finished path. Small nudges: the tests and button presses stay the main evidence. */
export function pathEvidence(p: PathStats, profile: Profile, room: RoomSpec, t: number): void {
  if (!readable(p)) return;
  const worst = [...p.doors].sort((a, b) => b.reversals - a.reversals)[0];
  if (worst && p.reversals >= 2) {
    const where = worst.reversals >= 2 ? `the ${labelOf(worst.label)} door and turned back ${worst.reversals} times` : `${p.reversals} doors and turned back from each`;
    profile.adjust('hesitation', Math.min(0.04 * p.reversals, 0.12), `walked up to ${where}`, room, t, 0.12);
  }
  if (p.deliberation !== undefined && p.commit !== undefined && p.deliberation >= 20 && p.commit <= 5)
    profile.adjust('hesitation', 0.05, `spent ${Math.round(p.deliberation)} s deciding, then reached the door in ${Math.round(p.commit)} s`, room, t, 0.12);
  if (p.coverage >= 0.55) profile.adjust('curiosity', 0.06, `walked over ${Math.round(p.coverage * 100)}% of the room`, room, t, 0.25);
  if (p.efficiency !== undefined && p.efficiency >= 0.8 && p.coverage <= 0.25 && p.walked > 3) {
    const route = p.efficiency >= 0.95 ? `${Math.round(p.walked)} m, about the shortest way` : `${Math.round(p.walked)} m where ${Math.round(p.shortest ?? 0)} m would do`;
    profile.adjust('curiosity', -0.04, `walked straight to the door (${route})`, room, t, 0.25);
    if ((p.deliberation ?? Infinity) < 4) profile.adjust('impulsivity', 0.04, 'set off for the exit without stopping to decide', room, t, 0.3);
  }
}

/** One plain sentence for the model, about how the player moved in a room. */
export function describePath(p: PathStats): string | undefined {
  if (!readable(p)) return undefined;
  const parts = [`Walked ${Math.round(p.walked)} m${p.shortest !== undefined ? ` (the shortest way out was ${Math.round(p.shortest)} m)` : ''}`, `covered ${Math.round(p.coverage * 100)}% of the floor`];
  const back = p.doors.filter((d) => d.reversals > 0);
  if (back.length) parts.push(`turned back from ${back.map((d) => `the ${labelOf(d.label)} door${d.reversals > 1 ? ` ${d.reversals} times` : ''}`).join(' and ')}`);
  if (p.deliberation !== undefined && p.commit !== undefined) parts.push(`decided after ${Math.round(p.deliberation)} s and took ${Math.round(p.commit)} s to reach the door`);
  return `Path: ${parts.join(', ')}.`;
}

function labelOf(label: string): string {
  return label ? label.toUpperCase() : 'unmarked';
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}
