import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { PathTracker } from '../../core/profile/path';
import { blockedCells, distanceAt, distanceField, roomFields, routeTo, walkableGrid } from '../../core/room/fields';
import { ARCHETYPES, generateLayout, type Archetype } from '../../core/room/layouts';
import type { Layout, RoomSpec, Side } from '../../core/room/types';
import { reachabilityProblems } from '../../core/room/validate';
import { Run } from '../../core/run/run';
import { createRng } from '../../core/util/random';

/** Walk a route at 1.4 m/s, sampled at 10 Hz. */
function walk(points: [number, number][], t0: number, from?: [number, number]): { x: number; z: number; t: number }[] {
  const out: { x: number; z: number; t: number }[] = [];
  let [px, pz] = from ?? points[0]!;
  let t = t0;
  for (const [x, z] of points) {
    const n = Math.max(1, Math.ceil(Math.hypot(x - px, z - pz) / 0.14));
    for (let i = 1; i <= n; i++) out.push({ x: px + ((x - px) * i) / n, z: pz + ((z - pz) * i) / n, t: (t += 0.1) });
    [px, pz] = [x, z];
  }
  return out;
}

const box = (w: number, d: number, rows?: string[]): Layout => ({
  archetype: 'test', width: w, depth: d, ceiling: 3, cells: rows ?? Array.from({ length: d }, () => '.'.repeat(w)),
  doors: [], slots: [], spawn: { x: w / 2, z: d - 0.5, yaw: 0 },
});

describe('distance fields', () => {
  it('measures walking distance around walls, not straight-line distance', () => {
    // A wall across the middle with a gap on the right: from the bottom-left to the top-left you must go round.
    const rows = ['.......', '.......', '######.', '.......', '.......'];
    const l = box(7, 5, rows);
    const f = distanceField(7, 5, walkableGrid(l, new Set()), [{ cx: 0, cz: 0, cost: 0 }]);
    const straight = 4; // (0,4) → (0,0)
    expect(f.d[4 * 7 + 0]!).toBeGreaterThan(straight + 6);
    expect(f.d[2 * 7 + 0]).toBe(Infinity); // a wall cell
    // Diagonals cost √2.
    expect(f.d[1 * 7 + 1]!).toBeCloseTo(Math.SQRT2, 5);
  });

  it('never cuts a blocked corner diagonally', () => {
    const rows = ['..', '#.'];
    const f = distanceField(2, 2, walkableGrid(box(2, 2, rows), new Set()), [{ cx: 0, cz: 0, cost: 0 }]);
    expect(f.d[1 * 2 + 1]!).toBeCloseTo(2, 5); // around, not √2 through the corner
  });

  it('agrees with the room validator on every archetype: each exit reachable from the spawn', () => {
    for (const archetype of ARCHETYPES) {
      for (let s = 0; s < 20; s++) {
        const layout = generateLayout({ archetype: archetype as Archetype, entranceSide: (['n', 'e', 's', 'w'] as Side[])[s % 4]!, exits: 1 + (s % 3), rng: createRng(s * 7 + 1), doorLabels: gameData.templates.doorLabels });
        const spec = { layout, props: [] } as unknown as RoomSpec;
        const fields = roomFields(spec, gameData);
        const ok = reachabilityProblems(layout, blockedCells(spec, gameData)).length === 0;
        expect(Object.values(fields.shortest).every(Number.isFinite), `${archetype} ${s}`).toBe(ok);
        for (const [id, f] of Object.entries(fields.exits)) {
          const route = routeTo(f, layout.spawn.x, layout.spawn.z);
          const door = layout.doors.find((d) => d.id === id)!;
          expect(route.at(-1), `${archetype} ${s} ${id}`).toEqual([door.cx + 0.5, door.cz + 0.5]);
        }
      }
    }
  });

  it('interpolates between cells, so distance changes smoothly as the player walks', () => {
    const l = box(8, 3);
    const f = distanceField(8, 3, walkableGrid(l, new Set()), [{ cx: 0, cz: 1, cost: 0.5 }]);
    const ds = [2.5, 2.75, 3, 3.25, 3.5].map((x) => distanceAt(f, x, 1.5));
    for (let i = 1; i < ds.length; i++) expect(ds[i]! - ds[i - 1]!).toBeCloseTo(0.25, 2);
  });
});

describe('path analysis', () => {
  function room(): { spec: RoomSpec; run: Run } {
    const run = new Run(41, gameData, { observeMs: 60_000, layout: { tests: 2, fillers: 1 } });
    const spec = run.start();
    return { spec, run };
  }

  it('counts walking up to a door and turning away as a reversal, and times the commitment', () => {
    const { spec, run } = room();
    const fields = run.fields!;
    const [a, b] = spec.layout.doors.filter((d) => !d.entrance);
    const tracker = new PathTracker(spec, fields, 0);
    const s = spec.layout.spawn;
    const toA = routeTo(fields.exits[a!.id]!, s.x, s.z);
    // Walk to door A (stop one cell short), come back to the spawn, wait, then walk to door B.
    const there = walk(toA.slice(0, -1), 0, [s.x, s.z]);
    const back = walk([...toA.slice(0, -1)].reverse(), there.at(-1)!.t, [there.at(-1)!.x, there.at(-1)!.z]);
    for (const p of [...there, ...back]) tracker.move(p.x, p.z, p.t);
    const waitUntil = back.at(-1)!.t + 10;
    for (let t = back.at(-1)!.t; t < waitUntil; t += 0.1) tracker.move(back.at(-1)!.x, back.at(-1)!.z, t);
    const end = back.at(-1)!;
    const toB = walk(routeTo(fields.exits[b!.id]!, end.x, end.z), waitUntil, [end.x, end.z]);
    for (const p of toB) tracker.move(p.x, p.z, p.t);
    const stats = tracker.finish(b!.id, toB.at(-1)!.t + 0.1);

    expect(stats.doors.find((d) => d.door === a!.id)!.reversals).toBe(1);
    expect(stats.doors.find((d) => d.door === b!.id)!.reversals).toBe(0);
    expect(stats.approached).toBe(2);
    expect(stats.efficiency!).toBeLessThan(0.7);
    // Committed when they set off for B after waiting, not at the start.
    expect(stats.deliberation!).toBeGreaterThan(waitUntil - 1);
    expect(stats.commit!).toBeLessThan(toB.length / 10 + 1);
  });

  it('a straight walk to the door is efficient and covers little of the room', () => {
    const { spec, run } = room();
    const fields = run.fields!;
    const door = spec.layout.doors.find((d) => !d.entrance)!;
    const tracker = new PathTracker(spec, fields, 0);
    const s = spec.layout.spawn;
    const pts = walk(routeTo(fields.exits[door.id]!, s.x, s.z), 0, [s.x, s.z]);
    for (const p of pts) tracker.move(p.x, p.z, p.t);
    const stats = tracker.finish(door.id, pts.at(-1)!.t);
    expect(stats.efficiency!).toBeGreaterThan(0.85);
    expect(stats.reversals).toBe(0);
    expect(stats.deliberation!).toBeLessThan(0.5);
  });

  it('feeds the run: turn-backs become profile evidence and a line for the model', () => {
    const { spec, run } = room();
    const fields = run.fields!;
    const exits = spec.layout.doors.filter((d) => !d.entrance);
    run.record({ type: 'room_entered', roomId: spec.id, t: 0 });
    const s = spec.layout.spawn;
    let pos: [number, number] = [s.x, s.z];
    let t = 0;
    // Approach each door twice and back off, then leave by the last.
    for (let rep = 0; rep < 2; rep++) for (const d of exits) {
      const route = routeTo(fields.exits[d.id]!, ...pos).slice(0, -1);
      const pts = [...walk(route, t, pos), ...walk([...route].reverse(), t + route.length, route.at(-1))];
      for (const p of pts) run.record({ type: 'move', roomId: spec.id, x: p.x, z: p.z, t: (t = p.t) });
      pos = [pts.at(-1)!.x, pts.at(-1)!.z];
    }
    const last = exits.at(-1)!;
    for (const p of walk(routeTo(fields.exits[last.id]!, ...pos), t, pos)) run.record({ type: 'move', roomId: spec.id, x: p.x, z: p.z, t: (t = p.t) });
    run.record({ type: 'door_chosen', roomId: spec.id, doorId: last.id, t: t + 0.1 });

    expect(run.paths).toHaveLength(1);
    expect(run.paths[0]!.reversals).toBeGreaterThanOrEqual(3);
    expect(run.profile.evidence.some((e) => e.trait === 'hesitation' && /turned back/.test(e.reason))).toBe(true);
    expect(run.describe(spec).some((l) => l.startsWith('Path:') && /turned back/.test(l))).toBe(true);
  });

  it('ignores runs with almost no position samples (scripted tests, a player who never moved)', () => {
    const { spec, run } = room();
    run.record({ type: 'room_entered', roomId: spec.id, t: 0 });
    run.record({ type: 'door_chosen', roomId: spec.id, doorId: spec.layout.doors.find((d) => !d.entrance)!.id, t: 3 });
    expect(run.profile.evidence.filter((e) => /walked|turned back/.test(e.reason))).toHaveLength(0);
    expect(run.describe(spec).some((l) => l.startsWith('Path:'))).toBe(false);
  });
});
