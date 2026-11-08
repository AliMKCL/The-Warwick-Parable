/**
 * Every message that crosses the core/adapter boundary.
 *
 * Core decides what happens; an adapter (Three.js now, Godot if we switch)
 * only draws RoomSpecs and reports what the player did. All types here are
 * plain JSON so they can travel over a WebSocket unchanged.
 */
import type { PathStats } from './profile/path';
import type { RoomSpec, SelectionNote } from './room/types';

/** What the player did. Sent adapter -> core. `t` is seconds since the run started. */
export type GameEvent =
  | { type: 'anomaly_action'; roomId: string; anomalyId: import('./anomalies/catalog').AnomalyId; action: 'use' | 'stay' | 'erase'; t: number }
  /** `selfRatings`: the player's own 1–5 ratings from the start screen, compared with what they did on the dossier. */
  | { type: 'run_started'; seed: number; t: number; selfRatings?: SelfRatings }
  | { type: 'room_entered'; roomId: string; t: number }
  | { type: 'looked_at'; roomId: string; objectId: string; seconds: number; t: number }
  | { type: 'inspected'; roomId: string; objectId: string; t: number }
  | { type: 'pressed'; roomId: string; objectId: string; t: number }
  | { type: 'door_hovered'; roomId: string; doorId: string; seconds: number; t: number }
  | { type: 'door_chosen'; roomId: string; doorId: string; t: number }
  | { type: 'corridor_interacted'; roomId: string; objectId: string; t: number }
  | { type: 'corridor_exit_requested'; roomId: string; t: number }
  | { type: 'corridor_exited'; roomId: string; t: number }
  | { type: 'idle'; roomId: string; seconds: number; t: number }
  | { type: 'went_back'; fromRoomId: string; toRoomId: string; t: number }
  /** The player started or stopped moving (sent after ~1.5 s of stillness, and on the first step after it). */
  | { type: 'motion'; roomId: string; moving: boolean; t: number }
  /** The player tried a locked door. */
  | { type: 'door_tried'; roomId: string; doorId: string; t: number }
  // ---- for tests that watch closely (the office tasks, core/testrooms/office) ----
  /** Position sample, sent at 10 Hz while a room is on screen. Metres = tiles. Not kept in the run's event log. */
  | { type: 'move'; roomId: string; x: number; z: number; t: number }
  /** Any key or mouse button press while playing; `target` is what the player was aiming at. Not kept in the event log. */
  | { type: 'input'; roomId: string; key: string; target?: string; t: number }
  /** The player answered an on-screen question (see AskSpec): an option index, a slider value, or where the meter stopped (0 to 1). */
  | { type: 'answer'; roomId: string; askId: string; value: number; seconds: number; t: number };

/**
 * An on-screen question a test asks: pick one of a few options, set a slider,
 * or stop a moving marker inside a highlighted zone (a timing challenge).
 * The adapter shows it and replies with an `answer` event; core decides what it means.
 */
export type AskSpec = { id: string; title: string; text?: string } & (
  | { mode: 'choice'; options: string[] }
  | { mode: 'slider'; min: number; max: number; step: number; value: number; unit?: string }
  /** The marker sweeps 0 → 1 → 0 at `speed` sweeps per second; `zone` is the target band. */
  | { mode: 'meter'; speed: number; zone: [number, number] }
);

/** Something a room rule changes in the world. The adapter shows it; core decides it. */
export type RuleEffect =
  /** Fade the room's lights to `level` (0 dark, 1 normal) over `seconds`. */
  | { kind: 'lights'; level: number; seconds: number }
  /** These exits are locked; all others are open. */
  | { kind: 'doors'; locked: string[] }
  /** Show a countdown, or hide it with seconds = null. */
  | { kind: 'timer'; seconds: number | null; label: string }
  /** Redraw the text on a prop (the lift's floor indicator). */
  | { kind: 'display'; prop: string; text: string }
  /** Turn a prop (a character) towards another prop, or 'player', for `seconds`, then back. */
  | { kind: 'glance'; prop: string; at: string; seconds: number }
  /** A prop can no longer be used. */
  | { kind: 'disable'; prop: string }
  /** Ask the player something on screen (closes itself when answered). */
  | { kind: 'ask'; ask: AskSpec }
  /** Close an open question without an answer ('*' closes any). */
  | { kind: 'ask_close'; id: string }
  /** Shake the view briefly (a harsh buzzer). */
  | { kind: 'shake'; seconds: number }
  /** A one-off sound. */
  | { kind: 'sound'; name: 'buzz' | 'pop' | 'clunk' | 'click' | 'pour' | 'spill' | 'ding' | 'squeak' | 'paper' }
  /** Scale a prop (an inflating balloon); 0 hides it. */
  | { kind: 'scale'; prop: string; scale: number }
  /** Turn a prop (a character) to face another prop, and stay that way (someone pointing the way). */
  | { kind: 'turn'; prop: string; at: string }
  /** Fade out, move the player, fade back in (a corridor that loops back). */
  | { kind: 'teleport'; x: number; z: number; yaw: number; dark: number }
  /** A short status line on screen (energy, party score); null hides it. */
  | { kind: 'status'; text: string | null };

/** One entry in the run's test log (moves, presses, answers… for tests that score from it). `t` is seconds on the run clock. */
export interface TaskEvent {
  t: number;
  task: string;
  type: string;
  data: Record<string, unknown>;
}

/** The hidden player profile, for the debug overlay and the final dossier. */
export interface ProfileSnapshot {
  traits: Record<TraitName, number>;
  /** Posterior standard deviation per trait: how unsure the estimate still is (0.2 = no evidence yet). */
  sd?: Record<TraitName, number>;
  evidence: Evidence[];
}
export type TraitName = 'hesitation' | 'curiosity' | 'compliance' | 'impulsivity';
export interface Evidence {
  t: number;
  room: number;
  trait: TraitName;
  delta: number;
  reason: string;
}

/** The four behaviours the player rates themselves on before playing, and is measured on. */
export type SelfTrait = 'risk' | 'patience' | 'social' | 'exploration';
/** 1 (not at all) to 5 (very); null if not given. */
export type SelfRatings = Record<SelfTrait, number | null>;

/** What the player actually did on one self-rated behaviour, on the same 1–5 scale. */
export interface Measured {
  /** 1–5, one decimal. */
  score: number;
  /** One concrete sentence, e.g. "You left before 3 of 4 countdowns ended." */
  evidence: string;
  /** How many moments it is based on. */
  n: number;
  /** True when there was no direct test this run and the score is inferred from the hidden profile. */
  estimated: boolean;
  /**
   * Only present once a task has reported a result this run (core/director/taskscore.ts).
   * The task measurements behind the score, with their evidence lines.
   */
  tasks?: TaskMeasure[];
  /** Only present when tasks were combined with ordinary signals: the ordinary signals' share (0..1), behind `evidence`. */
  ordinaryShare?: number;
  /** Only present with task results: the score rests on a single yes/no moment. Never a headline or a highlighted gap. */
  oneObservation?: boolean;
}

/** What a scored test (an office task) measured when the player left its room. Metric values are null when there wasn't enough to measure. */
export interface TaskResult {
  task: string;
  room: number;
  title: string;
  params: Record<string, number | string | boolean>;
  metrics: Record<string, number | null>;
  /** Plain sentences quoting the numbers, for the dossier and the model. */
  notes: string[];
  /** Which setting the task was played in. Absent means office (the only version so far). */
  version?: 'office' | 'mine';
}

/** Traits a task can feed that have no slider: measured, never compared with a self-rating. */
export type MeasuredOnlyTrait = 'helpfulness' | 'learning' | 'adaptability' | 'calibration' | 'trust' | 'trustworthiness' | 'boredom';
export type TaskTrait = SelfTrait | MeasuredOnlyTrait;

/** One task result turned into one value for one trait (core/director/taskscore.ts). */
export interface TaskMeasure {
  task: string;
  version: 'office' | 'mine';
  room: number;
  trait: TaskTrait;
  /** 0..1, higher = more of the trait. */
  value: number;
  weight: number;
  /** True when the value can fall between the ends (a time, a share); false for a single yes/no moment. */
  graded: boolean;
  /** False when recorded but deliberately not scored (the smoke room without a crowd). */
  counts: boolean;
  evidence: string;
  /** The task's raw metrics, as reported. */
  metrics: Record<string, number | null>;
}

/** A trait with no slider, scored from tasks only. */
export interface AlsoMeasured {
  trait: MeasuredOnlyTrait;
  label: string;
  /** 1–5, one decimal. */
  score: number;
  n: number;
  oneObservation: boolean;
  evidence: string[];
}

/** "You said / you did" for the dossier. */
export interface SaidDid {
  /** `did` and `gap` are null when the trait was not tested this run (`estimate` is the rough guess). */
  rows: { trait: SelfTrait; label: string; said: number | null; did: number | null; estimate: number; gap: number | null; evidence: string; estimated: boolean; oneObservation?: boolean }[];
  /** The single biggest gap in one line, or "You know yourself well." */
  headline: string;
  /** Second, smaller line under the headline. */
  detail: string;
  /** The trait behind the headline; null when every gap was small. */
  headlineTrait: SelfTrait | null;
}

/** Two hidden traits that point opposite ways, described as one pattern instead of two labels. */
export interface Pattern {
  traits: [TraitName, TraitName];
  sentence: string;
}

/** What core tells the adapter. Sent core -> adapter. */
export interface AnomalyEffect { roomId: string; stage: number; text: string; choice?: string }

export type CoreMessage =
  | { type: 'anomaly_effect'; effect: AnomalyEffect }
  | { type: 'load_room'; spec: RoomSpec }
  | { type: 'corridor_ready'; spec: RoomSpec; timing?: { corridorMs: number; exitWaitMs: number } }
  | { type: 'narrator_line'; lineId: string; text: string; final: boolean; interrupt?: boolean }
  | { type: 'gen_status'; model: 'on' | 'off'; doors: { door: string; status: string; ms?: number; error?: string }[] }
  | { type: 'rule_effect'; effect: RuleEffect }
  | { type: 'profile'; profile: ProfileSnapshot }
  /** A scored test finished (an office task): its metrics and its slice of the test log, for telemetry. */
  | { type: 'task_result'; result: TaskResult; log: TaskEvent[] }
  | { type: 'run_ended'; dossier: Dossier };

/** Everything the ending screen shows. */
export interface Dossier {
  seed: number;
  seconds: number;
  verdict: Verdict;
  verdictSource: 'model' | 'template';
  traits: Record<TraitName, number>;
  /** Posterior standard deviation per trait: ± how sure the file is (core/profile/bayes.ts). */
  certainty?: Record<TraitName, number>;
  /** Which test-selection method the run used. */
  selection?: 'adaptive' | 'weighted';
  /** The strongest moments behind each trait. */
  moments: Record<TraitName, Evidence[]>;
  rooms: {
    index: number;
    title: string;
    archetype: string;
    ambience: string;
    source: 'model' | 'template';
    genMs?: number;
    rule?: string;
    fact?: string;
    /** Trait scores when the player walked in. */
    traitsAtEntry: Record<TraitName, number>;
    /** What the model was told about the player for this room. */
    behaviour: string[];
    profile: string[];
    seed: number;
    size: string;
    /** Why the scheduler drew this room's test. */
    selection?: SelectionNote;
    /** How the player walked through the room (distance fields + path analysis). */
    path?: PathStats;
  }[];
  threads: { text: string; room: number; resolvedIn?: number }[];
  stats: { inspected: number; pressed: number; stoodStill: number; doorsTried: number };
  /** The player's behaviour on the four self-rated traits, 1–5. */
  measured: Record<SelfTrait, Measured>;
  /** Traits the original verdict name/summary contradicted; when any, they were rewritten from `measured`. */
  verdictConflicts: SelfTrait[];
  /** Present when the player rated themselves at the start. */
  saidDid?: SaidDid;
  /** Only present once a task has reported a result: every task measurement, scored or recorded only. */
  taskMeasures?: TaskMeasure[];
  /** Only present once a task has reported a result: traits with no slider (helpfulness, trust...). */
  alsoMeasured?: AlsoMeasured[];
  /** Contradictory trait pairs, each resolved into one sentence. */
  patterns: Pattern[];
  /** Every gamble: which door, and what happened. */
  gambles: { room: number; choice: 'safe' | 'risky'; outcome: 'certain' | 'shortcut' | 'setback'; timed: boolean; expired: boolean }[];
}

export interface Verdict {
  name: string;
  summary: string;
  hesitation: string;
  curiosity: string;
  compliance: string;
  impulsivity: string;
  closing: string;
}

/** The adapter-facing surface of core. In the browser it is called directly; for Godot it sits behind a WebSocket. */
export interface CorePort {
  send(event: GameEvent): void;
  onMessage(listener: (message: CoreMessage) => void): () => void;
}
