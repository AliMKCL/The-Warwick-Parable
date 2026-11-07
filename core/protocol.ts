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
  | { type: 'went_back'; fromRoomId: string; toRoomId: string; t: number };

/** What core tells the adapter. Sent core -> adapter. */
export type CoreMessage =
  | { type: 'load_room'; spec: RoomSpec }
  | { type: 'narrator_line'; lineId: string; text: string; final: boolean }
  | { type: 'gen_status'; model: 'on' | 'off'; doors: { door: string; status: string; ms?: number; error?: string }[] }
  | { type: 'rule_effect'; effect: unknown /* RuleEffect, defined in Phase 4 */ }
  | { type: 'run_ended'; dossier: unknown /* Dossier, defined in Phase 6 */ };

/** The adapter-facing surface of core. In the browser it is called directly; for Godot it sits behind a WebSocket. */
export interface CorePort {
  send(event: GameEvent): void;
  onMessage(listener: (message: CoreMessage) => void): () => void;
}
