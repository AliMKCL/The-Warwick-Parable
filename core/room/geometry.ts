import type { Layout, PropRecipe, Side, Slot } from './types';

export const DIR: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
export const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };
/** Rotating the grid 90° clockwise turns each side into this one. */
export const ROTATE_CW: Record<Side, Side> = { n: 'e', e: 's', s: 'w', w: 'n' };

/** Rotation about Y that makes a prop's front (+z) face the given direction. */
export function yawForFacing(face: Side): number {
  switch (face) {
    case 's': return 0;
    case 'n': return Math.PI;
    case 'e': return Math.PI / 2;
    case 'w': return -Math.PI / 2;
  }
}

export function isFloor(layout: Layout, cx: number, cz: number): boolean {
  return cz >= 0 && cz < layout.depth && cx >= 0 && cx < layout.width && layout.cells[cz]![cx] === '.';
}

export function cellKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Floor cells covered by the prop's footprint (empty for wall-mounted props). */
  cells: [number, number][];
}

/** Where a recipe ends up when put in a slot, or null if it doesn't fit. */
export function placeInSlot(recipe: PropRecipe, slot: Slot): Placement | null {
  if (!recipe.fits.includes(slot.kind)) return null;
  const [w, , d] = recipe.size;
  const [sx, sz] = slot.span;

  if (slot.kind === 'wall' || slot.kind === 'wall_mounted') {
    const side = slot.side!;
    const inward = OPPOSITE[side];
    const along = side === 'n' || side === 's' ? sx : sz;
    if (w > along + 0.05 || d > 0.95) return null;
    const rotY = yawForFacing(inward);
    const [ix, iz] = DIR[inward];
    const offset = slot.kind === 'wall_mounted' ? d / 2 + 0.006 : d / 2 + 0.03;
    // Wall plane coordinate and the centre of the span along the wall.
    let x: number, z: number;
    if (side === 'n' || side === 's') {
      z = side === 'n' ? slot.cz : slot.cz + 1;
      x = slot.cx + sx / 2;
    } else {
      x = side === 'w' ? slot.cx : slot.cx + 1;
      z = slot.cz + sz / 2;
    }
    x += ix * offset;
    z += iz * offset;
    if (slot.kind === 'wall_mounted') {
      return { x, y: recipe.mountHeight ?? 1.6, z, rotY, cells: [] };
    }
    return { x, y: 0, z, rotY, cells: footprintCells(x, z, rotY, w, d) };
  }

  // floor / center
  const face = slot.face ?? 's';
  const rotY = yawForFacing(face);
  const turned = face === 'e' || face === 'w';
  const fw = turned ? d : w;
  const fd = turned ? w : d;
  if (fw > sx + 0.1 || fd > sz + 0.1) return null;
  const x = slot.cx + sx / 2;
  const z = slot.cz + sz / 2;
  return { x, y: 0, z, rotY, cells: footprintCells(x, z, rotY, w, d) };
}

export function footprintCells(x: number, z: number, rotY: number, w: number, d: number): [number, number][] {
  const turned = Math.abs(Math.sin(rotY)) > 0.5;
  const hw = (turned ? d : w) / 2 - 0.06;
  const hd = (turned ? w : d) / 2 - 0.06;
  const cells: [number, number][] = [];
  for (let cz = Math.floor(z - hd); cz <= Math.floor(z + hd); cz++) {
    for (let cx = Math.floor(x - hw); cx <= Math.floor(x + hw); cx++) cells.push([cx, cz]);
  }
  return cells;
}

/** Axis-aligned footprint rectangle in world units, for collision. */
export function footprintRect(x: number, z: number, rotY: number, w: number, d: number) {
  const turned = Math.abs(Math.sin(rotY)) > 0.5;
  const hw = (turned ? d : w) / 2;
  const hd = (turned ? w : d) / 2;
  return { minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd };
}

/** Cells reachable on foot from a start cell, avoiding solid cells and blocked cells. */
export function reachable(layout: Layout, start: [number, number], blocked: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: [number, number][] = [start];
  if (!isFloor(layout, start[0], start[1]) || blocked.has(cellKey(...start))) return seen;
  seen.add(cellKey(...start));
  while (queue.length) {
    const [cx, cz] = queue.shift()!;
    for (const [dx, dz] of Object.values(DIR)) {
      const nx = cx + dx, nz = cz + dz;
      const k = cellKey(nx, nz);
      if (seen.has(k) || blocked.has(k) || !isFloor(layout, nx, nz)) continue;
      seen.add(k);
      queue.push([nx, nz]);
    }
  }
  return seen;
}
