import type { Profile } from '../profile/profile';
import type { GameEvent, RuleEffect, TraitName } from '../protocol';
import type { Archetype } from '../room/layouts';
import type { GameData, Layout, RoomSpec } from '../room/types';
import type { Rng } from '../util/random';

/**
 * A test: a mechanic a room can run to see how the player behaves (a countdown,
 * locked doors, a lift that never comes…). Each test lives in its own file in
 * `core/testrooms/kinds/` and is listed in `registry.ts`. Its lines live in
 * `data/templates.json` under `rules.<id>`, and `data/layout.json` decides how
 * often it is drawn. See core/testrooms/README.md for adding one.
 */
export interface TestKind {
  /** Also the id of the room's rule (RoomSpec.rule.id) and its key in templates.rules. */
  id: string;
  /** The room layouts this test can run in. One is drawn when the room is planned. */
  candidates: TestRoomCandidate[];
  /** Relative chance from the player's profile, multiplied by the weight in data/layout.json (default 1). */
  weight?(traits: Record<TraitName, number>): number;
  /** At most this many per run (data/layout.json can lower or raise it). */
  maxPerRun?: number;
  /** The next room must also be a test room (a won gamble skips the next room's task). */
  needsNextTest?: boolean;
  /** A set piece: no messy/ceiling variant or anomaly on top of it. */
  setPiece?: boolean;
  /** The model writes this room's content (default true). Set pieces with fixed text use templates only. */
  modelWritten?: boolean;
  /** The model (or the template filler) picks one exit as `params.door`, e.g. the door the narrator recommends. */
  picksDoor?: boolean;
  /**
   * Settings for this room's rule, once its layout exists. Return null for a test
   * with no rule at runtime (the door choice itself is the test, as in the choice room).
   */
  params(ctx: ParamsContext): Record<string, number | string> | null;
  /** What the model is told about the mechanic, so the room's text fits it. */
  describe(params: Record<string, number | string>): string;
  /** Template lines when the model doesn't write them (default: a random `line` and `done` from templates.rules.<id>). */
  templateLines?(params: Record<string, number | string>, room: RoomSpec, data: GameData, rng: Rng): { line: string; doneLine: string };
  /** Last touch on the finished room spec (labels, narrator lines), whoever wrote it. */
  dress?(spec: RoomSpec, data: GameData): RoomSpec;
  /** Runtime: the rule starts once the room has been introduced. `history` is the run's events so far. */
  start?(h: TestHandle, t: number, history: GameEvent[]): void;
  /** Runtime: every player event in the room. */
  onEvent?(h: TestHandle, e: GameEvent): void;
  /** An anomaly asks for extra seconds on a running clock; return true if granted. */
  borrowTime?(h: TestHandle, t: number, seconds: number): boolean;
}

export interface TestRoomCandidate {
  archetype: Archetype;
  /** Exit doors: a fixed number, or a range the profile picks within. Ignored by layouts with fixed doors. */
  exits?: number | [number, number];
  /** Relative chance among this test's candidates (default 1). */
  weight?: number;
}

export interface ParamsContext {
  layout: Layout;
  rng: Rng;
  profile: Profile;
  /** How many times each test has been used so far this run. */
  used: Record<string, number>;
}

/** What a running test can do. Timers made with `after` are cleared when the room is left. */
export interface TestHandle {
  readonly rule: { id: string; params: Record<string, number | string>; line: string; doneLine: string };
  readonly room: RoomSpec;
  readonly profile: Profile;
  readonly data: GameData;
  readonly rng: Rng;
  /** Free state for the test, reset per room. */
  readonly state: Record<string, unknown>;
  /** Exit door ids of the room. */
  readonly exits: string[];
  emit(effect: RuleEffect): void;
  say(text: string): void;
  /** Run `fn` after `seconds`, replacing any timer with the same name. */
  after(name: string, seconds: number, fn: () => void): void;
  clear(name: string): void;
  readonly stopped: boolean;
}
