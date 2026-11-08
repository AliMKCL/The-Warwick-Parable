import { cellKey, footprintCells, placeInSlot, yawForFacing } from './geometry';
import { reachabilityProblems } from './validate';
import type { GameData, Layout, PlacedProp } from './types';

/** "Put this prop in that slot", from the model or from templates. */
export interface Assignment {
  slot: string;
  recipe: string;
  surfaceText?: string;
  inspectText?: string;
  /** Placed on purpose (by the model, or a template's chosen piece), as opposed to filler furniture. */
  featured?: boolean;
}

export interface PlaceResult {
  props: PlacedProp[];
  /** Assignments that were dropped, and why. */
  rejected: { assignment: Assignment; reason: string }[];
}

/**
 * Places props one at a time and drops any that don't fit their slot, collide
 * with an earlier prop, cover a door, or cut off an exit. So whatever the
 * assignments say, the room stays playable.
 */
export function placeAssignments(layout: Layout, assignments: Assignment[], data: GameData): PlaceResult {
  const recipes = new Map(data.props.map((p) => [p.id, p]));
  const slots = new Map(layout.slots.map((s) => [s.id, s]));
  const doorCells = new Set(layout.doors.map((d) => cellKey(d.cx, d.cz)));
  const blocked = new Set<string>();
  const usedSlots = new Set<string>();
  const props: PlacedProp[] = [];
  const rejected: PlaceResult['rejected'] = [];

  // Fixtures (a lift, its call button) go first, exactly where the layout put them; slot props fit around them.
  for (const f of layout.fixtures ?? []) {
    const recipe = recipes.get(f.recipe);
    if (!recipe) continue;
    const rotY = yawForFacing(f.face);
    if (recipe.solid) for (const [cx, cz] of footprintCells(f.x, f.z, rotY, recipe.size[0], recipe.size[2])) blocked.add(cellKey(cx, cz));
    props.push({
      id: f.id,
      recipe: f.recipe,
      slot: 'fixture',
      x: round(f.x),
      y: round(f.y),
      z: round(f.z),
      rotY: round(rotY),
      surfaceText: recipe.text ? f.surfaceText : undefined,
      inspectText: recipe.inspectable ? f.inspectText : undefined,
    });
  }

  for (const a of assignments) {
    const reject = (reason: string) => rejected.push({ assignment: a, reason });
    const recipe = recipes.get(a.recipe);
    const slot = slots.get(a.slot);
    if (!recipe) { reject('unknown prop'); continue; }
    if (!slot) { reject('unknown slot'); continue; }
    if (usedSlots.has(slot.id)) { reject('slot already used'); continue; }
    const at = placeInSlot(recipe, slot);
    if (!at) { reject(`${recipe.id} does not fit a ${slot.kind} slot of ${slot.span.join('x')}`); continue; }

    if (recipe.solid && at.cells.length) {
      const keys = at.cells.map(([cx, cz]) => cellKey(cx, cz));
      if (keys.some((k) => blocked.has(k))) { reject('collides with another prop'); continue; }
      if (keys.some((k) => doorCells.has(k))) { reject('blocks a door'); continue; }
      const trial = new Set([...blocked, ...keys]);
      if (reachabilityProblems(layout, trial).length) { reject('would cut off an exit'); continue; }
      keys.forEach((k) => blocked.add(k));
    }

    usedSlots.add(slot.id);
    props.push({
      id: `p${props.filter((p) => p.slot !== 'fixture').length + 1}`,
      recipe: recipe.id,
      slot: slot.id,
      x: round(at.x),
      y: round(at.y),
      z: round(at.z),
      rotY: round(at.rotY),
      surfaceText: recipe.text ? a.surfaceText : undefined,
      inspectText: recipe.inspectable ? a.inspectText : undefined,
      ...(a.featured ? { featured: true } : {}),
    });
  }
  return { props, rejected };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
