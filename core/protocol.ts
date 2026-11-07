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

/** What core tells the adapter. Sent core -> adapter. */
export type CoreMessage =
  | { type: 'load_room'; spec: RoomSpec }
  | { type: 'narrator_line'; lineId: string; text: string; final: boolean }
  | { type: 'gen_status'; model: 'on' | 'off'; doors: { door: string; status: string; ms?: number; error?: string }[] }
  | { type: 'rule_effect'; effect: RuleEffect }
  | { type: 'profile'; profile: ProfileSnapshot }
  | { type: 'run_ended'; dossier: unknown /* Dossier, defined in Phase 6 */ };

/** The adapter-facing surface of core. In the browser it is called directly; for Godot it sits behind a WebSocket. */
export interface CorePort {
  send(event: GameEvent): void;
  onMessage(listener: (message: CoreMessage) => void): () => void;
}
