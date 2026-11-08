import type { AskSpec, GameEvent, RuleEffect, TaskEvent, TraitName } from '../../protocol';
import type { GameData, Layout, RoomSpec } from '../../room/types';
import type { Rng } from '../../util/random';
import type { Baseline } from './metrics';

/** A task's settings: its defaults (per session, from the seed) plus what its room layout adds (door ids). */
export type TaskParams = Record<string, number | string | boolean>;

/**
 * One office task from "Psychometric Game Tasks: Build Spec" (tasks 6 to 11),
 * as a self-contained module: its tunable parameters, a placeholder room,
 * its live logic, and its metrics.
 *
 * The room is the only part meant to be swapped out. `layout()` builds a
 * plain placeholder so the task is playable today (`?try=<id>`); when the
 * level generator can lay these rooms out properly, it only has to place
 * the fixtures and zones listed in `needs`, with the same ids, and the rest
 * of the module works unchanged.
 */
export interface OfficeTaskModule {
  id: OfficeTaskId;
  /** Number in the spec, e.g. '6' or '10a'. */
  number: string;
  /** What the room must contain, by id. The placeholder layout provides exactly these. */
  needs: { fixtures: { id: string; recipe: string; what: string }[]; zones: { id: string; what: string }[]; doors?: string };
  /** Per-session parameters (spec "Tunable parameters"), seeded from the run seed. */
  defaults(seed: number): TaskParams;
  /** Placeholder room, canonical (entrance on the south wall). Returns extra params such as door ids. */
  layout(p: TaskParams, rng: Rng, data: GameData): { layout: Layout; extra?: TaskParams };
  /** The player can see the room. */
  begin(ctx: ModuleCtx): void;
  /** Called on every event time (10 Hz while the player is in the room). */
  tick?(ctx: ModuleCtx, t: number): void;
  /** Presses, answers, holds, inspections and locked doors in this room. */
  onEvent?(ctx: ModuleCtx, e: GameEvent): void;
  onZone?(ctx: ModuleCtx, zone: string, entered: boolean): void;
  /** The player is leaving through `doorId` (log the door choice here if it matters). */
  onLeave?(ctx: ModuleCtx, doorId: string): void;
  /** Pure function of this task's slice of the log. */
  score(events: TaskEvent[], s: ModuleScoreContext): { metrics: Record<string, number | null>; notes: string[] };
  /** Nudge the hidden profile from the metrics, so the generator and the dossier see the task. */
  profile?(m: Record<string, number | null>, adjust: (trait: TraitName, delta: number, reason: string) => void): void;
}

export type OfficeTaskId = 'balloons' | 'coffee' | 'canteen' | 'renumbered' | 'pitch' | 'loan' | 'lockdown';

/** A task's fixed wording in data/tasks.json ("office"): narrator and character lines, and on-prop labels. */
export interface OfficeTaskTexts {
  title: string;
  brief: string;
  lines: Record<string, string>;
  labels?: Record<string, string>;
}

export interface ModuleScoreContext {
  params: TaskParams;
  baseline: Baseline | null;
  all: TaskEvent[];
}

/** What a module can do while it runs. Everything it logs is tagged `version: 'office'`. */
export interface ModuleCtx {
  readonly room: RoomSpec;
  readonly p: TaskParams;
  readonly data: GameData;
  /** Free-form state for this task occurrence. */
  readonly state: Record<string, unknown>;
  /** The fixed lines and labels for this task (data/tasks.json, "office"). */
  readonly text: OfficeTaskTexts;
  /** Run-clock time of the event being handled, and of task start. */
  now(): number;
  t0(): number;
  log(type: string, data?: Record<string, unknown>): void;
  /** Say a fixed line from `text.lines`, or any text with its own key. Logged with its on-screen timing. */
  say(key: string, text?: string): void;
  emit(effect: RuleEffect): void;
  /** Open an on-screen question; logs prompt_shown. The answer arrives as an `answer` event. */
  ask(a: AskSpec): void;
  /** A seeded random stream for this task, so a session replays exactly. */
  rng(label: string): Rng;
  /** Last known player position. */
  player(): { x: number; z: number } | undefined;
  inZone(zone: string): boolean;
  exits(): string[];
}
