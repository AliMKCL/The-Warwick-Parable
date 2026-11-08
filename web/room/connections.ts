import { doorPoint } from '../../core/corridors/corridor';
import { DIR } from '../../core/room/geometry';
import type { DoorView, Rect, RoomView } from './buildRoom';

/** Rooms stay axis-aligned on the same metre grid; only their world offsets change. */
export function joinRooms(from: RoomView, exit: DoorView, to: RoomView, entrance: DoorView) {
  const a = doorPoint(exit.door), b = doorPoint(entrance.door);
  to.group.position.set(from.group.position.x + a.x - b.x, 0, from.group.position.z + a.z - b.z);
  exit.passage.visible = entrance.passage.visible = false;
  // A single visible leaf at a shared doorway: the outgoing room owns it until sealed.
  entrance.pivot.visible = false;
  entrance.open = entrance.target = 1;
  entrance.locked = false;
  to.group.updateMatrixWorld(true);
}

export function crossed(view: RoomView, door: DoorView, p: { x: number; z: number }) {
  const center = doorPoint(door.door), [dx, dz] = DIR[door.door.side];
  const x = p.x - center.x - view.group.position.x, z = p.z - center.z - view.group.position.z;
  return x * dx + z * dz > 0.6 && Math.abs(x * dz - z * dx) < 0.65;
}

export function walkableIn(views: RoomView[], cx: number, cz: number) {
  return views.some((v) => v.isWalkable(Math.round(cx - v.group.position.x), Math.round(cz - v.group.position.z)));
}

/** Real door slabs and jambs prevent walking through a shut door even with floor on both sides. */
export function connectedColliders(views: RoomView[]): Rect[] {
  return views.flatMap((v) => {
    const ox = v.group.position.x, oz = v.group.position.z;
    const rects = v.colliders.map((r) => ({ minX: r.minX + ox, maxX: r.maxX + ox, minZ: r.minZ + oz, maxZ: r.maxZ + oz }));
    for (const d of v.doors) {
      const p = doorPoint(d.door), x = p.x + ox, z = p.z + oz;
      const horizontal = d.door.side === 'n' || d.door.side === 's';
      const spans = d.locked || d.open < 0.8 ? [[-0.5, 0.5]] : [[-0.5, -0.44], [0.44, 0.5]];
      for (const [lo, hi] of spans) rects.push(horizontal
        ? { minX: x + lo!, maxX: x + hi!, minZ: z - 0.06, maxZ: z + 0.06 }
        : { minX: x - 0.06, maxX: x + 0.06, minZ: z + lo!, maxZ: z + hi! });
    }
    return rects;
  });
}
