import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR, footprintRect, isFloor } from '../../core/room/geometry';
import type { PropRecipe, RoomSpec, Side } from '../../core/room/types';
import { createRng, deriveSeed } from '../../core/util/random';
import type { Rect } from './buildRoom';

type Resource = { dispose(): void };
export const windowKey = (x: number, z: number, side: Side) => `${x},${z},${side}`;

export function planWallDetails(spec: RoomSpec, recipes: ReadonlyMap<string, PropRecipe>) {
  const { layout } = spec;
  const rng = createRng(deriveSeed(spec.seed, 'wall-details'));
  const nearby = [...spec.props, ...(spec.anomaly ? [spec.anomaly.anchor] : [])].map((prop) => {
    const recipe = recipes.get(prop.recipe);
    const [width, height, depth] = recipe?.size ?? [0.95, 2.5, 0.9];
    const footprint = footprintRect(prop.x, prop.z, prop.rotY, width, depth);
    return { ...footprint, top: prop.y + height };
  });
  const candidates: { key: string; side: Side; order: number }[] = [];
  for (let z = 0; z < layout.depth; z++) {
    for (let x = 0; x < layout.width; x++) {
      if (!isFloor(layout, x, z)) continue;
      for (const side of Object.keys(DIR) as Side[]) {
        const [dx, dz] = DIR[side];
        const outside = x + dx < 0 || z + dz < 0 || x + dx >= layout.width || z + dz >= layout.depth;
        if (!outside || layout.doors.some((door) => door.side === side && Math.abs(door.cx - x) + Math.abs(door.cz - z) <= 1)) continue;
        const wallX = x + 0.5 + dx * 0.5, wallZ = z + 0.5 + dz * 0.5;
        const obstructed = spec.variant !== 'ceiling' && nearby.some((p) =>
          p.top > 1.12 && p.minX < wallX + 0.47 && p.maxX > wallX - 0.47 &&
          p.minZ < wallZ + 0.47 && p.maxZ > wallZ - 0.47,
        );
        if (!obstructed) candidates.push({ key: windowKey(x, z, side), side, order: rng() });
      }
    }
  }
  candidates.sort((a, b) => a.order - b.order);
  const windows = new Set<string>();
  const usedSides = new Set<Side>();
  const count = Math.min(4, Math.max(2, Math.floor((layout.width + layout.depth) / 6)));
  for (const cell of candidates) {
    if (usedSides.has(cell.side)) continue;
    windows.add(cell.key);
    usedSides.add(cell.side);
    if (windows.size >= count) break;
  }
  for (const cell of candidates) {
    if (windows.size >= count) break;
    windows.add(cell.key);
  }
  const fixtures = new Set(candidates.filter((cell) => !windows.has(cell.key)).slice(0, 6).map((cell) => cell.key));
  return { windows, fixtures };
}

/** Align the base of each inverted furnishing with the ceiling. The bounds also
 * keep tall pieces above head height without affecting the ground-level routes. */
export function mountOnCeiling(object: THREE.Group, height: number) {
  object.rotateZ(Math.PI);
  const bounds = new THREE.Box3().setFromObject(object);
  const hangingHeight = bounds.max.y - bounds.min.y;
  object.scale.multiplyScalar(Math.min(1, (height - 1.9) / hangingHeight));
  bounds.setFromObject(object);
  object.position.y += height - 0.001 - bounds.max.y;
}

/** Low debris leaves the walking routes clear. */
export function addMess(spec: RoomSpec, group: THREE.Group, colliders: readonly Rect[], owned: Resource[]) {
  const { layout } = spec;
  const rng = createRng(deriveSeed(spec.seed, 'scattered-records'));
  const piles: THREE.BufferGeometry[][] = [[], [], [], []];
  const colors = ['#e9e3cc', '#fff0cf', '#a64e39', '#816444'];
  const count = Math.min(130, layout.width * layout.depth * 2);
  for (let i = 0; i < count; i++) {
    const x = 0.4 + rng() * (layout.width - 0.8);
    const z = 0.4 + rng() * (layout.depth - 0.8);
    if (!isFloor(layout, Math.floor(x), Math.floor(z)) ||
      layout.doors.some((door) => Math.hypot(x - door.cx - 0.5, z - door.cz - 0.5) < 1) ||
      colliders.some((r) => x > r.minX - 0.25 && x < r.maxX + 0.25 && z > r.minZ - 0.25 && z < r.maxZ + 0.25)) continue;
    const kind = Math.floor(rng() * piles.length);
    const height = [0.007, 0.018, 0.028, 0.13][kind]!;
    const geometry = new THREE.BoxGeometry(0.18 + rng() * 0.18, height, 0.23 + rng() * 0.16);
    geometry.rotateY(rng() * Math.PI * 2).translate(x, height / 2 + 0.003 + rng() * 0.008, z);
    piles[kind]!.push(geometry);
  }
  piles.forEach((pieces, i) => {
    if (!pieces.length) return;
    const geometry = mergeGeometries(pieces)!;
    pieces.forEach((piece) => piece.dispose());
    const material = new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.92 });
    const debris = new THREE.Mesh(geometry, material);
    debris.receiveShadow = true;
    debris.castShadow = i === 3;
    group.add(debris);
    owned.push(geometry, material);
  });
}
