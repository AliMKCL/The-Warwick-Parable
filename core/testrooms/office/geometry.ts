import type { Fixture, Side } from '../../room/types';

/** Placement helpers for task fixtures (from PR #6, core/tasks/layouts.ts). */

/** Centre of a prop standing against a wall. */
export function against(side: Side, along: number, W: number, D: number, depth: number): Pick<Fixture, 'x' | 'z' | 'face'> {
  return spot(side, along, W, D, depth / 2 + 0.03);
}

/** Centre of a thin wall-mounted prop. */
export function onWall(side: Side, along: number, W: number, D: number, depth: number): Pick<Fixture, 'x' | 'z' | 'face'> {
  return spot(side, along, W, D, depth / 2 + 0.006);
}

function spot(side: Side, along: number, W: number, D: number, off: number): Pick<Fixture, 'x' | 'z' | 'face'> {
  switch (side) {
    case 'n': return { x: along, z: off, face: 's' };
    case 's': return { x: along, z: D - off, face: 'n' };
    case 'w': return { x: off, z: along, face: 'e' };
    case 'e': return { x: W - off, z: along, face: 'w' };
  }
}

/** Every cell in the rectangle [x0..x1] x [z0..z1]. */
export function cells(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push([x, z]);
  return out;
}
