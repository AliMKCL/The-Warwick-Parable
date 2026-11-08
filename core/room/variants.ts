import { createRng, deriveSeed } from '../util/random';
import type { RoomSpec } from './types';

const variants = {
  ceiling: {
    title: 'Gravity Services',
    line: 'Facilities has reassigned gravity. Your desk is now above you. You may continue using the floor.',
    fact: 'Every loose furnishing in Gravity Services is fixed upside down to the ceiling.',
  },
  messy: {
    title: 'Unsorted Records',
    line: 'Everything is in order. The order is chronological, beginning with whatever fell first.',
    fact: 'Unsorted Records is littered with dropped paperwork, folders and parcels.',
  },
};

/** Roll once per visited room. Each variant can appear once per run. */
export function applyRoomVariant(room: RoomSpec, visited: readonly RoomSpec[], last: number): void {
  if (room.index === 0 || room.index >= last || visited.at(-1)?.variant || !room.props.length) return;

  const roll = createRng(deriveSeed(room.seed, 'room-variant'))();
  const variant = roll < 0.055 ? 'ceiling' : roll < 0.14 ? 'messy' : undefined;
  if (!variant || visited.some((previous) => previous.variant === variant)) return;
  if (variant === 'ceiling' && !room.props.some((prop) => prop.recipe === 'desk_office' || prop.recipe === 'terminal_desk')) return;

  const detail = variants[variant];
  room.variant = variant;
  room.title = detail.title;
  room.fact = detail.fact;
  room.narrator.onEnter = detail.line;
  if (variant === 'ceiling') room.layout = { ...room.layout, ceiling: Math.max(3.35, room.layout.ceiling) };
}
