import { ANOMALY_ANCHOR } from '../anomalies/catalog';
import { cellKey, footprintCells, isFloor } from './geometry';
import type { GameData, Layout, RoomSpec } from './types';

/**
 * Distance fields: for each exit, the true walking distance (around walls and
 * furniture) from every floor cell to that door, computed once when a room is
 * entered. After that, "how far is the player from each door?" is a table
 * lookup, so the 10 Hz position samples can be read for approach, retreat and
 * commitment without any path-finding per sample.
 *
 * Built with Dijkstra on the 1 m grid, 8-connected (diagonals cost √2, and
 * never cut a blocked corner), so distances are close to what a player walks.
 * Costs are metres, not seconds: changing walking speed does not change the
 * fields. PathTracker measures commitment time from actual sample timestamps.
 */

/** A per-cell distance table, row-major (index = cz * width + cx). Infinity where unreachable. */
export interface DistanceField {
  width: number;
  depth: number;
  d: Float32Array;
}

export interface RoomFields {
  width: number;
  depth: number;
  /** 1 where the player can stand (floor, not under a solid prop). */
  walkable: Uint8Array;
  /** Walkable cells reachable from the spawn. */
  reachableCells: number;
  /** One field per exit door, by door id. */
  exits: Record<string, DistanceField>;
  /** Shortest walk from the spawn to each exit, metres. */
  shortest: Record<string, number>;
  /** Time it took to build, ms (for the debug overlay and the benchmark). */
  buildMs?: number;
}

/** Cells under solid floor props (the same rule the room validator uses). */
export function blockedCells(spec: Pick<RoomSpec, 'props' | 'anomaly'>, data: GameData): Set<string> {
  const recipes = new Map([...data.props, ANOMALY_ANCHOR].map((p) => [p.id, p]));
  const blocked = new Set<string>();
  for (const p of [...spec.props, ...(spec.anomaly ? [spec.anomaly.anchor] : [])]) {
    const recipe = recipes.get(p.recipe);
    if (!recipe || !recipe.solid || recipe.fits.every((f) => f === 'wall_mounted')) continue;
    for (const [cx, cz] of footprintCells(p.x, p.z, p.rotY, recipe.size[0], recipe.size[2])) blocked.add(cellKey(cx, cz));
  }
  return blocked;
}

export function walkableGrid(layout: Layout, blocked: Set<string>): Uint8Array {
  const w = new Uint8Array(layout.width * layout.depth);
  for (let cz = 0; cz < layout.depth; cz++)
    for (let cx = 0; cx < layout.width; cx++) if (isFloor(layout, cx, cz) && !blocked.has(cellKey(cx, cz))) w[cz * layout.width + cx] = 1;
  return w;
}

const STEPS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Dijkstra from one or more source cells (each with a starting cost). A small
 * binary heap keeps it O(n log n); rooms are a few hundred cells, so a field
 * takes a few microseconds.
 */
export function distanceField(width: number, depth: number, walkable: Uint8Array, sources: { cx: number; cz: number; cost: number }[]): DistanceField {
  const n = width * depth;
  const d = new Float32Array(n).fill(Infinity);
  const heap = new Heap();
  for (const s of sources) {
    const i = s.cz * width + s.cx;
    if (s.cx < 0 || s.cz < 0 || s.cx >= width || s.cz >= depth || !walkable[i]) continue;
    const c = Math.fround(s.cost);
    if (c < d[i]!) { d[i] = c; heap.push(i, c); }
  }
  while (heap.size) {
    const [i, cost] = heap.pop();
    if (cost > d[i]!) continue;
    const cx = i % width, cz = (i / width) | 0;
    for (const [dx, dz, step] of STEPS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
      const j = nz * width + nx;
      if (!walkable[j]) continue;
      // A diagonal step may not squeeze between two blocked cells' corners.
      if (dx && dz && (!walkable[cz * width + nx] || !walkable[nz * width + cx])) continue;
      // Costs are kept at float32 precision on both sides, or a rounded-down table entry would hide the cell from the heap.
      const c = Math.fround(cost + step);
      if (c < d[j]!) { d[j] = c; heap.push(j, c); }
    }
  }
  return { width, depth, d };
}

/** Fields for every exit of a room: built once on entry. */
export function roomFields(spec: Pick<RoomSpec, 'layout' | 'props' | 'anomaly'>, data: GameData, now?: () => number): RoomFields {
  const t0 = now?.();
  const { layout } = spec;
  const walkable = walkableGrid(layout, blockedCells(spec, data));
  const exits: Record<string, DistanceField> = {};
  const shortest: Record<string, number> = {};
  // A door cell's centre is half a metre from the door itself.
  for (const door of layout.doors.filter((d) => !d.entrance)) exits[door.id] = distanceField(layout.width, layout.depth, walkable, [{ cx: door.cx, cz: door.cz, cost: 0.5 }]);
  const spawn = { cx: Math.floor(layout.spawn.x), cz: Math.floor(layout.spawn.z) };
  const fromSpawn = distanceField(layout.width, layout.depth, walkable, [{ ...spawn, cost: 0 }]);
  let reachableCells = 0;
  for (let i = 0; i < fromSpawn.d.length; i++) if (fromSpawn.d[i] !== Infinity) reachableCells++;
  for (const id of Object.keys(exits)) shortest[id] = distanceAt(exits[id]!, layout.spawn.x, layout.spawn.z);
  const out: RoomFields = { width: layout.width, depth: layout.depth, walkable, reachableCells, exits, shortest };
  if (t0 !== undefined) out.buildMs = now!() - t0;
  return out;
}

/**
 * Walking distance from a point to a field's door: bilinear between the four
 * nearest cell centres (unreachable ones left out), so it changes smoothly as
 * the player moves instead of in 1 m steps. Infinity off the grid.
 */
export function distanceAt(f: DistanceField, x: number, z: number): number {
  const gx = x - 0.5, gz = z - 0.5;
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const fx = gx - x0, fz = gz - z0;
  let sum = 0, wsum = 0;
  for (const [cx, cz, w] of [[x0, z0, (1 - fx) * (1 - fz)], [x0 + 1, z0, fx * (1 - fz)], [x0, z0 + 1, (1 - fx) * fz], [x0 + 1, z0 + 1, fx * fz]] as const) {
    if (cx < 0 || cz < 0 || cx >= f.width || cz >= f.depth || w <= 0) continue;
    const v = f.d[cz * f.width + cx]!;
    if (v === Infinity) continue;
    sum += v * w;
    wsum += w;
  }
  if (wsum > 0) return sum / wsum;
  // Standing in a cell whose neighbours are all blocked (against furniture): use the cell itself.
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= f.width || cz >= f.depth) return Infinity;
  return f.d[cz * f.width + cx]!;
}

/**
 * The shortest walk from (x, z) to a field's door, as cell centres: follow the
 * field downhill (the field is its own path-finder; no search needed). Used by
 * the scripted players in tests and the benchmark.
 */
export function routeTo(f: DistanceField, x: number, z: number): [number, number][] {
  let cx = Math.floor(x), cz = Math.floor(z);
  const out: [number, number][] = [];
  for (let guard = 0; guard < f.width * f.depth; guard++) {
    out.push([cx + 0.5, cz + 0.5]);
    const here = f.d[cz * f.width + cx]!;
    if (here <= 0.5 + 1e-6) break;
    let best = here, bx = cx, bz = cz;
    for (const [dx, dz, step] of STEPS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= f.width || nz >= f.depth) continue;
      const v = f.d[nz * f.width + nx]!;
      // Only steps that are on a shortest path (same rule as the field: no corner cutting).
      if (v + step <= here + 1e-4 && v < best) { best = v; bx = nx; bz = nz; }
    }
    if (bx === cx && bz === cz) break;
    cx = bx; cz = bz;
  }
  return out;
}

/** Minimal binary min-heap of (index, cost). */
class Heap {
  private idx: number[] = [];
  private cost: number[] = [];
  get size() {
    return this.idx.length;
  }
  push(i: number, c: number) {
    this.idx.push(i);
    this.cost.push(c);
    let k = this.idx.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.cost[p]! <= this.cost[k]!) break;
      this.swap(k, p);
      k = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.idx[0]!, this.cost[0]!];
    const li = this.idx.pop()!, lc = this.cost.pop()!;
    if (this.idx.length) {
      this.idx[0] = li;
      this.cost[0] = lc;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < this.idx.length && this.cost[l]! < this.cost[m]!) m = l;
        if (r < this.idx.length && this.cost[r]! < this.cost[m]!) m = r;
        if (m === k) break;
        this.swap(k, m);
        k = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.idx[a], this.idx[b]] = [this.idx[b]!, this.idx[a]!];
    [this.cost[a], this.cost[b]] = [this.cost[b]!, this.cost[a]!];
  }
}
