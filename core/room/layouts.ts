import { pick, randInt, type Rng } from '../util/random';
import { DIR, ROTATE_CW } from './geometry';
import type { Door, Layout, Side, Slot } from './types';

/**
 * Seeded layout generators. Each builds its room with the entrance on the
 * south wall (+z) and the player facing north, then the whole layout is
 * rotated so the entrance lines up with the door the player came through.
 */

export const ARCHETYPES = ['waiting_room', 'corridor', 'open_office', 'hub', 'l_gallery', 'u_gallery'] as const;
export const CHOICE_ROOM = 'choice_room';
export type Archetype = (typeof ARCHETYPES)[number] | typeof CHOICE_ROOM;

export interface LayoutOptions {
  archetype: Archetype;
  /** The wall the player enters through. */
  entranceSide: Side;
  /** Number of ways out (1 to 3). */
  exits: number;
  rng: Rng;
  /** Door labels to draw from. */
  doorLabels: string[];
}

export function generateLayout(opts: LayoutOptions): Layout {
  const canonical = BUILDERS[opts.archetype](opts);
  const turns = { s: 0, w: 1, n: 2, e: 3 }[opts.entranceSide];
  let layout = canonical;
  for (let i = 0; i < turns; i++) layout = rotateCW(layout);
  return layout;
}

// ---------- archetypes (canonical: entrance on the south wall) ----------

const BUILDERS: Record<Archetype, (o: LayoutOptions) => Layout> = {
  waiting_room(o) {
    const w = randInt(o.rng, 7, 9), d = randInt(o.rng, 7, 9);
    const b = new Builder('waiting_room', w, d, 3.0, o);
    const ex = b.entrance();
    b.exits(o.exits, ['n', 'e', 'w']);
    const cx = Math.floor(w / 2) - 1, cz = Math.floor(d / 2) - 1;
    b.slot('center', cx, cz, [2, 2], ['center', 'feature'], 's');
    b.wallSlots();
    b.spawnAt(ex);
    return b.done();
  },

  corridor(o) {
    const w = 3, d = randInt(o.rng, 12, 16);
    const b = new Builder('corridor', w, d, 2.7, o);
    const ex = b.entrance(1);
    const ends: Side[] = ['n'];
    if (o.exits > 1) ends.push(o.rng() < 0.5 ? 'e' : 'w');
    if (o.exits > 2) ends.push(ends[1] === 'e' ? 'w' : 'e');
    b.door('n', 1);
    for (const side of ends.slice(1)) b.door(side, randInt(o.rng, 1, 4));
    b.wallSlots(['wall_mounted', 'wall_mounted', 'wall']);
    b.spawnAt(ex);
    return b.done();
  },

  open_office(o) {
    const w = randInt(o.rng, 10, 13), d = randInt(o.rng, 10, 12);
    const b = new Builder('open_office', w, d, 3.0, o);
    const ex = b.entrance();
    b.exits(o.exits, ['n', 'e', 'w']);
    // Desk pods on a 3-cell rhythm, leaving one-cell aisles between them.
    for (let pz = 2; pz + 1 <= d - 3; pz += 3) {
      for (let px = 2; px + 1 <= w - 3; px += 3) {
        const face: Side = o.rng() < 0.5 ? 's' : 'n';
        b.slot('floor', px, pz, [2, 1], ['desk'], face);
        if (o.rng() < 0.6) b.slot('floor', px, face === 's' ? pz + 1 : pz - 1, [2, 1], ['partition'], face);
      }
    }
    b.wallSlots();
    b.spawnAt(ex);
    return b.done();
  },

  hub(o) {
    const w = pick(o.rng, [9, 11]), d = w;
    const b = new Builder('hub', w, d, 3.6, o);
    for (const [px, pz] of [[2, 2], [w - 3, 2], [2, d - 3], [w - 3, d - 3]] as const) b.solid(px, pz);
    const ex = b.entrance();
    b.exits(Math.max(2, o.exits), ['n', 'e', 'w']);
    const c = Math.floor(w / 2);
    b.slot('center', c, c, [1, 1], ['center', 'feature'], 's');
    b.wallSlots();
    b.spawnAt(ex);
    return b.done();
  },

  l_gallery(o) {
    const w = randInt(o.rng, 9, 11), d = randInt(o.rng, 8, 10);
    const b = new Builder('l_gallery', w, d, 3.0, o);
    for (let z = 0; z < d - 4; z++) {
      for (let x = 4; x < w; x++) b.solid(x, z);
    }
    const entrance = b.entrance(w - 2);
    b.door('n', randInt(o.rng, 1, 2));
    if (o.exits >= 2) b.door('e', d - 3);
    if (o.exits >= 3) b.door('w', d - 3);
    b.wallSlots();
    b.spawnAt(entrance, Math.PI * 0.42);
    return b.done();
  },

  u_gallery(o) {
    const w = randInt(o.rng, 10, 12), d = randInt(o.rng, 8, 10);
    const b = new Builder('u_gallery', w, d, 3.0, o);
    for (let z = 0; z < d - 5; z++) {
      for (let x = 3; x < w - 3; x++) b.solid(x, z);
    }
    const entrance = b.entrance(Math.floor(w / 2));
    const [first, second] = o.rng() < 0.5 ? [1, w - 2] : [w - 2, 1];
    b.door('n', first);
    if (o.exits >= 2) b.door('n', second);
    if (o.exits >= 3) b.door('e', d - 3);
    b.wallSlots();
    b.spawnAt(entrance);
    return b.done();
  },

  [CHOICE_ROOM](o) {
    const b = new Builder(CHOICE_ROOM, 7, 6, 3.0, o);
    const entrance = b.entrance(3);
    b.door('n', 1, { label: 'A', color: '#1e62b6' });
    b.door('n', 5, { label: 'B', color: '#c46119' });
    b.wallSlots(['wall_mounted']);
    b.spawnAt(entrance);
    return b.done();
  },
};

// ---------- builder ----------

class Builder {
  private cells: string[][];
  private doors: Door[] = [];
  private slots: Slot[] = [];
  private spawn = { x: 0, z: 0, yaw: 0 };
  private labels: string[];

  constructor(
    private archetype: string,
    private w: number,
    private d: number,
    private ceiling: number,
    private o: LayoutOptions,
  ) {
    this.cells = Array.from({ length: d }, () => Array.from({ length: w }, () => '.'));
    this.labels = [...o.doorLabels];
  }

  solid(cx: number, cz: number) {
    this.cells[cz]![cx] = '#';
  }

  /** Entrance on the south wall; returns its column. */
  entrance(at?: number): number {
    const cx = at ?? randInt(this.o.rng, 1, this.w - 2);
    this.doors.push({ id: 'in', cx, cz: this.d - 1, side: 's', label: '', entrance: true });
    return cx;
  }

  door(side: Side, index: number, marking?: Pick<Door, 'label' | 'color'>) {
    const [cx, cz] = this.edgeCell(side, index);
    const n = this.doors.filter((x) => !x.entrance).length + 1;
    const label = marking?.label ?? (this.labels.length ? this.labels.splice(Math.floor(this.o.rng() * this.labels.length), 1)[0]! : String(n));
    this.doors.push({ id: `d${n}`, cx, cz, side, label, entrance: false, ...marking });
  }

  exits(count: number, sides: Side[]) {
    const order = [...sides].sort(() => this.o.rng() - 0.5);
    for (let i = 0; i < Math.min(3, Math.max(1, count)); i++) {
      const side = order[i % order.length]!;
      const len = side === 'n' || side === 's' ? this.w : this.d;
      for (let tries = 0; tries < 20; tries++) {
        const idx = randInt(this.o.rng, 1, len - 2);
        const [cx, cz] = this.edgeCell(side, idx);
        if (this.cells[cz]![cx] !== '.') continue;
        if (this.doors.some((x) => Math.abs(x.cx - cx) + Math.abs(x.cz - cz) < 3)) continue;
        this.door(side, idx);
        break;
      }
    }
  }

  slot(kind: Slot['kind'], cx: number, cz: number, span: [number, number], tags: string[], face?: Side, side?: Side) {
    this.slots.push({ id: `s${this.slots.length + 1}`, kind, cx, cz, span, tags, face, side });
  }

  /** Fill the free stretches of every wall with floor-standing and wall-mounted slots. */
  wallSlots(kinds: Slot['kind'][] = ['wall', 'wall_mounted', 'wall']) {
    for (const side of ['n', 's', 'e', 'w'] as Side[]) {
      const len = side === 'n' || side === 's' ? this.w : this.d;
      let i = 0;
      while (i < len) {
        const span = this.o.rng() < 0.5 ? 2 : 1;
        if (i + span > len || !this.wallFree(side, i, span)) {
          i++;
          continue;
        }
        const [cx, cz] = this.edgeCell(side, i);
        const kind = kinds[Math.floor(this.o.rng() * kinds.length)]!;
        const along: [number, number] = side === 'n' || side === 's' ? [span, 1] : [1, span];
        const ax = side === 'n' || side === 's' ? cx : cx;
        const az = side === 'n' || side === 's' ? cz : cz;
        this.slot(kind, ax, az, along, ['wall'], undefined, side);
        i += span + 1;
      }
    }
  }

  spawnAt(entranceX: number, yaw = 0) {
    this.spawn = { x: entranceX + 0.5, z: this.d - 0.75, yaw };
  }

  done(): Layout {
    return {
      archetype: this.archetype,
      width: this.w,
      depth: this.d,
      ceiling: this.ceiling,
      cells: this.cells.map((r) => r.join('')),
      doors: this.doors,
      slots: this.slots,
      spawn: this.spawn,
    };
  }

  /** The floor cell at position `index` along a wall (west to east, or north to south). */
  private edgeCell(side: Side, index: number): [number, number] {
    switch (side) {
      case 'n': return [index, 0];
      case 's': return [index, this.d - 1];
      case 'w': return [0, index];
      case 'e': return [this.w - 1, index];
    }
  }

  /** No door within one cell, the wall is not blocked by a solid cell, and no existing slot overlaps. */
  private wallFree(side: Side, start: number, span: number): boolean {
    for (let k = start; k < start + span; k++) {
      const [cx, cz] = this.edgeCell(side, k);
      if (this.cells[cz]![cx] !== '.') return false;
      for (const door of this.doors) {
        if (Math.abs(door.cx - cx) <= 1 && Math.abs(door.cz - cz) <= 1) return false;
      }
      // Corner cells are shared by two walls; leave them to the first wall that claims them.
      if (this.slots.some((s) => s.side && covers(s, cx, cz))) return false;
    }
    return true;
  }
}

function covers(s: Slot, cx: number, cz: number): boolean {
  return cx >= s.cx && cx < s.cx + s.span[0] && cz >= s.cz && cz < s.cz + s.span[1];
}

// ---------- rotation ----------

/** Rotate a whole layout 90° clockwise (seen from above, x right, z down). */
export function rotateCW(l: Layout): Layout {
  const W = l.width, D = l.depth;
  const cells: string[] = [];
  for (let nz = 0; nz < W; nz++) {
    let row = '';
    for (let nx = 0; nx < D; nx++) row += l.cells[D - 1 - nx]![nz];
    cells.push(row);
  }
  return {
    ...l,
    width: D,
    depth: W,
    cells,
    doors: l.doors.map((d) => ({ ...d, cx: D - 1 - d.cz, cz: d.cx, side: ROTATE_CW[d.side] })),
    slots: l.slots.map((s) => ({
      ...s,
      cx: D - s.cz - s.span[1],
      cz: s.cx,
      span: [s.span[1], s.span[0]],
      side: s.side && ROTATE_CW[s.side],
      face: s.face && ROTATE_CW[s.face],
    })),
    spawn: { x: D - l.spawn.z, z: l.spawn.x, yaw: l.spawn.yaw - Math.PI / 2 },
  };
}

export { DIR };
