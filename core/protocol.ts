/**
 * Every message that crosses the core/adapter boundary.
 *
 * Core decides what happens; an adapter (Three.js now, Godot if we switch)
 * only draws RoomSpecs and reports what the player did. All types here are
 * plain JSON so they can travel over a WebSocket unchanged.
 */
import type { RoomSpec } from './room/types';

/** What the player did. Sent adapter -> core. `t` is seconds since the run started. */
export type GameEvent =
  | { type: 'anomaly_action'; roomId: string; anomalyId: import('./anomalies/catalog').AnomalyId; action: 'use' | 'stay' | 'erase'; t: number }
  | { type: 'run_started'; seed: number; t: number }
  | { type: 'room_entered'; roomId: string; t: number }
  | { type: 'looked_at'; roomId: string; objectId: string; seconds: number; t: number }
  | { type: 'inspected'; roomId: string; objectId: string; t: number }
  | { type: 'pressed'; roomId: string; objectId: string; t: number }
  | { type: 'door_hovered'; roomId: string; doorId: string; seconds: number; t: number }
  | { type: 'door_chosen'; roomId: string; doorId: string; t: number }
  | { type: 'idle'; roomId: string; seconds: number; t: number }
  | { type: 'went_back'; fromRoomId: string; toRoomId: string; t: number }
  /** The player started or stopped moving (sent after ~1.5 s of stillness, and on the first step after it). */
  | { type: 'motion'; roomId: string; moving: boolean; t: number }
  /** The player tried a locked door. */
  | { type: 'door_tried'; roomId: string; doorId: string; t: number }
  // ---- office task telemetry (see core/tasks) ----
  /** Position sample, sent at 10 Hz while a room is on screen and the game isn't paused. Metres = tiles. */
  | { type: 'move'; roomId: string; x: number; z: number; t: number }
  /** Any key or mouse button press while playing; `target` is what the player was aiming at. */
  | { type: 'input'; roomId: string; key: string; target?: string; t: number }
  /** An interaction prompt appeared on screen for an object. */
  | { type: 'prompt'; roomId: string; objectId: string; t: number }
  /** The player closed an inspect card after reading it for `seconds`. */
  | { type: 'inspect_closed'; roomId: string; objectId: string; seconds: number; t: number }
  /** The player started holding E on a hold-to-use object. */
  | { type: 'hold_start'; roomId: string; objectId: string; t: number }
  /** The player let go (or finished). */
  | { type: 'hold_end'; roomId: string; objectId: string; seconds: number; completed: boolean; t: number }
  /** A narrator line actually appeared on screen (it may have queued behind another). */
  | { type: 'narrator_shown'; lineId: string; t: number };

/** Something a room rule changes in the world. The adapter shows it; core decides it. */
export type RuleEffect =
  /** Fade the room's lights to `level` (0 dark, 1 normal) over `seconds`. */
  | { kind: 'lights'; level: number; seconds: number }
  /** These exits are locked; all others are open. */
  | { kind: 'doors'; locked: string[] }
  /** Show a countdown, or hide it with seconds = null. */
  | { kind: 'timer'; seconds: number | null; label: string }
  /** Stylised smoke from a prop (a vent), growing to `level` (0 none, 1 full) over `seconds`. */
  | { kind: 'smoke'; from: string; level: number; seconds: number }
  /** Redraw the text on a prop (e.g. a lift's floor indicator). */
  | { kind: 'display'; prop: string; text: string }
  /** Turn a prop (a character) towards another prop for `seconds`, then back. */
  | { kind: 'glance'; prop: string; at: string; seconds: number }
  /** Remove a prop from the room (picked up). */
  | { kind: 'hide'; prop: string }
  /** The fire alarm bell, on or off. */
  | { kind: 'alarm'; on: boolean };

/** The hidden player profile, for the debug overlay and the final dossier. */
export interface ProfileSnapshot {
  traits: Record<TraitName, number>;
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

/** What core tells the adapter. Sent core -> adapter. */
export interface AnomalyEffect { roomId: string; stage: number; text: string; choice?: string }

export type CoreMessage =
  | { type: 'anomaly_effect'; effect: AnomalyEffect }
  | { type: 'load_room'; spec: RoomSpec }
  | { type: 'narrator_line'; lineId: string; text: string; final: boolean }
  | { type: 'gen_status'; model: 'on' | 'off'; doors: { door: string; status: string; ms?: number; error?: string }[] }
  | { type: 'rule_effect'; effect: RuleEffect }
  | { type: 'profile'; profile: ProfileSnapshot }
  /** An office task finished; its metrics and its slice of the event log (for telemetry and replay). */
  | { type: 'task_result'; result: TaskResult; log: TaskEvent[] }
  | { type: 'run_ended'; dossier: Dossier };

/** One entry in the shared task event log (core/tasks/log.ts). `t` is seconds on the run clock. */
export interface TaskEvent {
  t: number;
  task: string;
  type: string;
  data: Record<string, unknown>;
}

/** What one office task measured. Metric values are null when there wasn't enough to measure. */
export interface TaskResult {
  task: string;
  room: number;
  title: string;
  params: Record<string, number | string | boolean>;
  metrics: Record<string, number | null>;
  /** Plain sentences quoting the numbers, for the dossier and the model. */
  notes: string[];
}

/** Everything the ending screen shows. */
export interface Dossier {
  seed: number;
  seconds: number;
  verdict: Verdict;
  verdictSource: 'model' | 'template';
  traits: Record<TraitName, number>;
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
  }[];
  threads: { text: string; room: number; resolvedIn?: number }[];
  stats: { inspected: number; pressed: number; stoodStill: number; doorsTried: number };
  /** Office tasks the player went through, with their metrics. */
  tasks: TaskResult[];
  /** The player's own normal from the first room, which timing metrics are compared against. */
  baseline: Record<string, number | null>;
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
