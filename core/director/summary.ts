import { definition } from '../anomalies/catalog';
import type { GameEvent } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';

/**
 * Turns the raw event log for one room into plain sentences the model can
 * use: how long the player stayed, what they read, how long they hesitated.
 * Only things that actually happened are reported.
 */
export function describeVisit(room: RoomSpec, events: GameEvent[], data: GameData): string[] {
  const mine = events.filter((e) => 'roomId' in e && e.roomId === room.id);
  const entered = mine.find((e) => e.type === 'room_entered')?.t;
  if (entered === undefined) return [];
  const left = mine.find((e) => e.type === 'door_chosen')?.t;
  const name = (objectId: string) => propLabel(room, objectId, data);
  const lines: string[] = [];
  if (room.anomaly) {
    lines.push(`The room contained ${definition(room.anomaly.id).name}.`);
    for (const e of mine) if (e.type === 'anomaly_action') lines.push(`At ${definition(e.anomalyId).name}, the player chose ${e.action === 'stay' ? 'permission to stay' : e.action === 'erase' ? 'to retrace their footprints' : definition(e.anomalyId).action.toLowerCase()}.`);
  }

  if (left !== undefined) lines.push(`Stayed ${secs(left - entered)}.`);
  const firstAct = mine.find((e) => e.type === 'inspected' || e.type === 'pressed' || e.type === 'door_chosen');
  if (firstAct && firstAct.t - entered >= 8) lines.push(`Did nothing for ${secs(firstAct.t - entered)} after arriving.`);

  const presses = mine.filter((e) => e.type === 'pressed');
  if (presses.length) {
    lines.push(`Pressed the ${name(presses[0]!.objectId)} after ${secs(presses[0]!.t - entered)}${presses.length > 1 ? `, then ${presses.length - 1} more time(s)` : ''}.`);
  } else if (room.props.some((p) => data.props.find((r) => r.id === p.recipe)?.interact === 'button')) {
    lines.push('Never pressed the button.');
  }

  const inspected = unique(mine.filter((e) => e.type === 'inspected').map((e) => name(e.objectId)));
  if (inspected.length) lines.push(`Inspected: ${inspected.join('; ')}.`);
  else lines.push('Inspected nothing.');

  const stares = mine
    .filter((e): e is Extract<GameEvent, { type: 'looked_at' }> => e.type === 'looked_at' && e.seconds >= 2.5)
    .map((e) => `${name(e.objectId)} (${secs(e.seconds)})`);
  if (stares.length) lines.push(`Stared at: ${unique(stares).slice(0, 4).join('; ')}.`);

  const idle = mine.filter((e) => e.type === 'idle').reduce((a, e) => a + (e.type === 'idle' ? e.seconds : 0), 0);
  if (idle >= 6) lines.push(`Stood completely still for ${secs(idle)} in total.`);

  const hovers = mine.filter((e) => e.type === 'door_hovered');
  const chosen = mine.find((e) => e.type === 'door_chosen');
  const label = (doorId: string) => room.layout.doors.find((d) => d.id === doorId)?.label || doorId;
  if (hovers.length) lines.push(`Hesitated at door(s): ${unique(hovers.map((e) => (e.type === 'door_hovered' ? `"${label(e.doorId)}"` : ''))).join(', ')}.`);
  if (chosen?.type === 'door_chosen') {
    const others = room.layout.doors.filter((d) => !d.entrance && d.id !== chosen.doorId).map((d) => `"${d.label}"`);
    lines.push(`Chose the door "${label(chosen.doorId)}"${others.length ? ` over ${others.join(' and ')}` : ''}.`);
  }
  return lines;
}

function propLabel(room: RoomSpec, objectId: string, data: GameData): string {
  if (room.anomaly && objectId.startsWith(`anomaly:${room.anomaly.id}`)) return definition(room.anomaly.id).name.toLowerCase();
  const p = room.props.find((x) => x.id === objectId);
  if (!p) return 'something';
  const recipe = data.props.find((r) => r.id === p.recipe);
  const base = (recipe?.name ?? p.recipe).toLowerCase();
  const text = p.surfaceText?.replace(/\s+/g, ' ').slice(0, 40);
  return text ? `${base} saying "${text}"` : base;
}

function secs(n: number): string {
  return `${Math.round(n)} s`;
}
function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
