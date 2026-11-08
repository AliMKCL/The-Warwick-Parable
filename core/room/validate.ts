import { cellKey, DIR, footprintCells, isFloor, reachable } from './geometry';
import type { GameData, Layout, RoomSpec } from './types';

/**
 * Checks that a room is playable: doors are on outer walls, solid props don't
 * overlap or block doors, and every exit can be reached on foot. Used on every
 * generated room, including model-made ones, before the player sees it.
 */
export function validateRoom(spec: RoomSpec, data: GameData): string[] {
  const problems: string[] = [];
  const { layout } = spec;
  const recipes = new Map(data.props.map((p) => [p.id, p]));

  const entrances = layout.doors.filter((d) => d.entrance);
  if (entrances.length !== 1) problems.push(`expected 1 entrance, found ${entrances.length}`);
  if (layout.doors.filter((d) => !d.entrance).length < 1) problems.push('no exits');
  for (const d of layout.doors) {
    const [dx, dz] = DIR[d.side];
    if (!isFloor(layout, d.cx, d.cz)) problems.push(`door ${d.id} is not on a floor cell`);
    if (isFloor(layout, d.cx + dx, d.cz + dz)) problems.push(`door ${d.id} is not on an outer wall`);
  }
  if (new Set(layout.doors.map((d) => d.id)).size !== layout.doors.length) problems.push('duplicate door ids');

  const blocked = new Set<string>();
  const doorCells = new Set(layout.doors.map((d) => cellKey(d.cx, d.cz)));
  for (const p of spec.props) {
    const recipe = recipes.get(p.recipe);
    if (!recipe) {
      problems.push(`unknown prop ${p.recipe}`);
      continue;
    }
    if (p.x < 0 || p.z < 0 || p.x > layout.width || p.z > layout.depth) problems.push(`${p.id} is outside the room`);
    if (!recipe.solid || recipe.fits.every((f) => f === 'wall_mounted')) continue;
    for (const [cx, cz] of footprintCells(p.x, p.z, p.rotY, recipe.size[0], recipe.size[2])) {
      const k = cellKey(cx, cz);
      if (blocked.has(k)) problems.push(`${p.id} overlaps another prop at ${k}`);
      if (doorCells.has(k)) problems.push(`${p.id} blocks a door at ${k}`);
      blocked.add(k);
    }
  }

  problems.push(...reachabilityProblems(layout, blocked));
  return problems;
}

export function reachabilityProblems(layout: Layout, blocked: Set<string>): string[] {
  const entrance = layout.doors.find((d) => d.entrance);
  if (!entrance) return [];
  const spawnCell: [number, number] = [Math.floor(layout.spawn.x), Math.floor(layout.spawn.z)];
  if (blocked.has(cellKey(...spawnCell))) return ['spawn point is blocked'];
  const seen = reachable(layout, spawnCell, blocked);
  return layout.doors
    .filter((d) => !d.entrance && !seen.has(cellKey(d.cx, d.cz)))
    .map((d) => `exit ${d.id} cannot be reached`);
}
