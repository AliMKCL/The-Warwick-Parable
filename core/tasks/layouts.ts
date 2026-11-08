import { Builder, orient } from '../room/layouts';
import type { Fixture, GameData, Layout, Side } from '../room/types';
import type { Rng } from '../util/random';
import type { TaskId, TaskParams } from './params';

/**
 * Seeded layouts for the office tasks. Like every other room they are built
 * with the entrance on the south wall (player facing north, so west is the
 * player's left) and then rotated to match the door the player came through.
 * Task props are fixtures at exact spots; the rest of the room is decorated
 * through ordinary slots, by the model or by templates.
 *
 * Returns the layout and the task's params, completed with the ids of the
 * doors, props and zones the task watches.
 */
export function buildTaskLayout(
  id: TaskId,
  params: TaskParams,
  entranceSide: Side,
  rng: Rng,
  data: GameData,
): { layout: Layout; params: TaskParams } {
  const { layout, extra } = BUILDERS[id](params, rng, data);
  return { layout: orient(layout, entranceSide), params: { ...params, ...extra } };
}

type Built = { layout: Layout; extra: TaskParams };

const BUILDERS: Record<TaskId, (p: TaskParams, rng: Rng, data: GameData) => Built> = {
  /** 1. A small room with two doors side by side on the far wall. */
  two_doors(p, rng, data) {
    const W = 7, D = 6;
    const t = data.tasks.two_doors;
    const b = new Builder('two_doors', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(3);
    const leftAllowed = p.instructedSide === 'left';
    const left = b.door('n', 1, { label: leftAllowed ? t.allowedLabel : t.forbiddenLabel });
    const right = b.door('n', W - 2, { label: leftAllowed ? t.forbiddenLabel : t.allowedLabel });
    b.zone({ id: 'door_left', x: 1.5, z: 0, r: 1.8 });
    b.zone({ id: 'door_right', x: W - 1.5, z: 0, r: 1.8 });
    b.reserve([[2, 0], [3, 0], [4, 0]]);
    b.wallSlots();
    b.spawnAt(ex);
    return {
      layout: b.done(),
      extra: { leftDoor: left, rightDoor: right, allowedDoor: leftAllowed ? left : right, forbiddenDoor: leftAllowed ? right : left },
    };
  },

  /** 2. A lift that never comes, and a stairwell door nobody mentions. */
  lift(p, rng, data) {
    const W = 8, D = 8;
    const t = data.tasks.lift;
    const b = new Builder('lift_lobby', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(2);
    const tucked = p.stairs === 'tucked';
    const stairsRow = tucked ? D - 2 : 2;
    const stairs = b.door('e', stairsRow, { label: tucked ? '' : t.stairsLabel });
    b.fixture({ id: 't_lift', recipe: 'lift_doors', ...against('n', 4, W, D, 0.24), y: 0, surfaceText: t.floors[0] }, cells(2, 0, 6, 1));
    b.fixture({ id: 't_call', recipe: 'lift_call', ...onWall('n', 5.35, W, D, 0.04), y: 1.15 });
    b.zone({ id: 'lift', x: 4, z: 1.5, r: 1.9 });
    b.zone({ id: 'stairs', x: W - 0.9, z: stairsRow + 0.5, r: 1.5 });
    b.reserve(cells(W - 1, stairsRow - 1, W - 1, stairsRow + 1));
    b.wallSlots();
    b.spawnAt(ex);
    return { layout: b.done(), extra: { stairsDoor: stairs, liftProp: 't_lift', callProp: 't_call' } };
  },

  /** 3. A corridor past an abandoned desk, its things a step off the direct path. */
  desk(p, rng, data) {
    const W = p.offset === 'far' ? 6 : 5, D = 14;
    const t = data.tasks.desk;
    const b = new Builder('desk_corridor', W, D, 2.7, { rng, doorLabels: [] });
    const ex = b.entrance(2);
    const exit = b.door('n', 2, { label: t.exitLabel });
    // The desk against the west wall, facing the corridor.
    b.fixture({ id: 't_desk', recipe: 'desk_bare', ...against('w', 7, W, D, 0.7), y: 0 }, cells(0, 5, 1, 8));
    const items: Record<string, Omit<Fixture, 'id' | 'surfaceText' | 'inspectText'>> = {
      sticky: { recipe: 'sticky_note', ...onWall('w', 6.45, W, D, 0.01), y: 1.22 },
      email: { recipe: 'monitor_email', x: 0.33, z: 7.05, face: 'e', y: 0.75 },
      drawer: { recipe: 'drawer_pedestal', ...against('w', 5.55, W, D, 0.55), y: 0 },
      photo: { recipe: 'photo_frame', ...against('e', 8.5, W, D, 0.5), y: 0.62 },
      mug: { recipe: 'coffee_mug', x: 0.55, z: 6.55, face: 'e', y: 0.75 },
      calendar: { recipe: 'wall_calendar', ...onWall('e', 5.5, W, D, 0.02), y: 1.45 },
    };
    // The sticky note (and its door number) is always there; the rest in a fixed order.
    const chosen = ['sticky', 'email', 'drawer', 'photo', 'mug', 'calendar'].slice(0, Math.max(3, Math.min(6, Number(p.items) || 5)));
    const extra: TaskParams = { exitDoor: exit, items: chosen.length, itemProps: chosen.map((k) => `t_${k}`).join(',') };
    for (const key of chosen) {
      const text = t.items[key]!;
      const fid = `t_${key}`;
      b.fixture({ id: fid, ...items[key]!, surfaceText: text.surface, inspectText: text.text, reach: 1.25 });
      if (text.reading) extra[`words_${fid}`] = text.text.split(/\s+/).filter(Boolean).length;
    }
    if (chosen.includes('photo')) b.fixture({ id: 't_side_table', recipe: 'side_table', ...against('e', 8.5, W, D, 0.5), y: 0 }, cells(W - 1, 8, W - 1, 8));
    b.reserve(cells(W - 1, 4, W - 1, 6));
    b.wallSlots(['wall_mounted', 'wall_mounted', 'wall']);
    b.spawnAt(ex);
    const layout = b.done();
    // Straight-line length from the spawn point to the exit, the shortest route down a straight corridor.
    extra.shortest = round(Math.hypot(layout.spawn.x - 2.5, layout.spawn.z - 0));
    return { layout, extra };
  },

  /** 4. A long corridor to the boardroom, and a colleague stuck at a printer on the way. */
  meeting(p, rng, data) {
    const W = 5, D = 16;
    const t = data.tasks.meeting;
    const b = new Builder('meeting_corridor', W, D, 2.7, { rng, doorLabels: [] });
    const ex = b.entrance(2);
    const board = b.door('n', 2, { label: t.boardLabel });
    const secret = b.door('e', 3, { label: t.secretLabel });
    b.fixture({ id: 't_printer', recipe: 'printer_jammed', ...against('w', 8.5, W, D, 0.62), y: 0, surfaceText: 'PAPER JAM', holdSeconds: Number(p.helpSeconds) || 8 }, cells(0, 7, 1, 10));
    b.fixture({ id: 't_colleague', recipe: 'colleague', x: 0.75, z: 9.55, face: 'e', y: 0 });
    b.zone({ id: 'colleague', x: 1.2, z: 9, r: 2.8 });
    b.zone({ id: 'far_end', x: 2.5, z: 2.5, r: 3 });
    b.reserve(cells(W - 1, 2, W - 1, 4));
    b.wallSlots(['wall_mounted', 'wall_mounted', 'wall']);
    b.spawnAt(ex);
    return { layout: b.done(), extra: { boardDoor: board, secretDoor: secret, printerProp: 't_printer', colleagueProp: 't_colleague' } };
  },

  /** 5. An open-plan office, a file to fetch, and smoke from a vent. */
  smoke(p, rng, data) {
    const W = 10, D = 10;
    const t = data.tasks.smoke;
    const b = new Builder('smoky_office', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(5);
    const other = b.door('n', 8, { label: t.otherLabel });
    const fireExit = b.door('e', 7, { label: t.exitLabel });
    // The far desk with the file, in the north-west corner.
    b.fixture({ id: 't_far_desk', recipe: 'desk_bare', ...against('n', 2, W, D, 0.7), y: 0 }, cells(0, 0, 3, 1));
    b.fixture({ id: 't_file', recipe: 'file_folder', x: 2.1, z: 0.5, face: 's', y: 0.75, surfaceText: t.fileLabel });
    b.fixture({ id: 't_vent', recipe: 'vent_grille', ...onWall('e', 3, W, D, 0.04), y: 2.55 });
    b.fixture({ id: 't_alarm', recipe: 'fire_alarm', ...onWall('e', 5.6, W, D, 0.06), y: 1.35, surfaceText: 'FIRE' });
    b.reserve(cells(W - 1, 2, W - 1, 8));
    // Desks with workers (or empty desks when the player is alone).
    const crowd = p.condition !== 'alone';
    // Desk centres on half-metres so desk and chair each take one row of cells.
    const desks: [number, number][] = [[4.5, 4.5], [7.5, 4.5], [2.5, 7.5]].slice(0, Math.max(1, Math.min(3, Number(p.workers) || 3))) as [number, number][];
    const workers: string[] = [];
    desks.forEach(([x, z], i) => {
      b.fixture({ id: `t_desk${i + 1}`, recipe: 'terminal_desk', x, z, face: 's', y: 0, surfaceText: SCREENS[i % SCREENS.length], inspectText: 'A spreadsheet, mid-edit. Column F is entirely question marks.' });
      if (crowd) {
        b.fixture({ id: `t_worker${i + 1}`, recipe: ['worker_seated', 'worker_seated_b', 'worker_seated_c'][i % 3]!, x, z: z + 0.9, face: 'n', y: 0 });
        workers.push(`t_worker${i + 1}`);
      }
      b.reserve(cells(Math.floor(x) - 1, Math.floor(z) - 1, Math.floor(x) + 1, Math.floor(z) + 1));
    });
    b.zone({ id: 'file_desk', x: 2, z: 1.3, r: 2.2 });
    b.zone({ id: 'vent', x: W - 1.4, z: 3, r: 2 });
    b.zone({ id: 'fire_exit', x: W - 0.8, z: 7.5, r: 1.4 });
    b.wallSlots();
    b.spawnAt(ex);
    return {
      layout: b.done(),
      extra: { fileProp: 't_file', ventProp: 't_vent', alarmProp: 't_alarm', fireExitDoor: fireExit, otherDoor: other, workerProps: workers.join(',') },
    };
  },
};

const SCREENS = ['Q3 FORECAST\n=SUM(F2:F40)\n#REF!', 'INBOX (214)\nRe: fire drill\nRe: Re: fire drill', 'TICKET 5521\nStatus: smells odd\nAssigned: nobody'];

/** Centre of a floor prop of `depth` standing against a wall, `along` metres along it. */
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

function round(n: number) {
  return Math.round(n * 100) / 100;
}
