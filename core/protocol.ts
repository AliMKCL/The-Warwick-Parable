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
  /** `selfRatings`: the player's own 1–5 ratings from the start screen, compared with what they did on the dossier. */
  | { type: 'run_started'; seed: number; t: number; selfRatings?: SelfRatings }
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
  | { type: 'door_tried'; roomId: string; doorId: string; t: number };

/** Something a room rule changes in the world. The adapter shows it; core decides it. */
export type RuleEffect =
  /** Fade the room's lights to `level` (0 dark, 1 normal) over `seconds`. */
  | { kind: 'lights'; level: number; seconds: number }
  /** These exits are locked; all others are open. */
  | { kind: 'doors'; locked: string[] }
  /** Show a countdown, or hide it with seconds = null. */
  | { kind: 'timer'; seconds: number | null; label: string };

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
}

/** "You said / you did" for the dossier. */
export interface SaidDid {
  /** `did` and `gap` are null when the trait was not tested this run (`estimate` is the rough guess). */
  rows: { trait: SelfTrait; label: string; said: number | null; did: number | null; estimate: number; gap: number | null; evidence: string; estimated: boolean }[];
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
export type CoreMessage =
  | { type: 'load_room'; spec: RoomSpec }
  | { type: 'narrator_line'; lineId: string; text: string; final: boolean }
  | { type: 'gen_status'; model: 'on' | 'off'; doors: { door: string; status: string; ms?: number; error?: string }[] }
  | { type: 'rule_effect'; effect: RuleEffect }
  | { type: 'profile'; profile: ProfileSnapshot }
  | { type: 'run_ended'; dossier: Dossier };

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
  /** The player's behaviour on the four self-rated traits, 1–5. */
  measured: Record<SelfTrait, Measured>;
  /** Traits the original verdict name/summary contradicted; when any, they were rewritten from `measured`. */
  verdictConflicts: SelfTrait[];
  /** Present when the player rated themselves at the start. */
  saidDid?: SaidDid;
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
