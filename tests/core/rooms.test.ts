import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { ARCHETYPES, generateLayout } from '../../core/room/layouts';
import { placeAssignments } from '../../core/room/place';
import { templateAssignments } from '../../core/room/templates';
import { validateRoom } from '../../core/room/validate';
import type { RoomSpec, Side } from '../../core/room/types';
import { createRng } from '../../core/util/random';
import { Run } from '../../core/run/run';

const SIDES: Side[] = ['n', 's', 'e', 'w'];

function build(archetype: (typeof ARCHETYPES)[number], seed: number, side: Side, exits: number): RoomSpec {
  const rng = createRng(seed);
  const layout = generateLayout({ archetype, entranceSide: side, exits, rng, doorLabels: gameData.templates.doorLabels });
  const { props } = placeAssignments(layout, templateAssignments(layout, gameData, rng, { index: 1 }), gameData);
  return { id: 'x', index: 1, seed, layout, props, ambience: 'cold', narrator: { onEnter: '', doors: {} }, source: 'template' };
}

describe('room generator', () => {
  it('produces playable rooms for every archetype, orientation and exit count', () => {
    let rooms = 0;
    for (const archetype of ARCHETYPES)
      for (const side of SIDES)
        for (let exits = 1; exits <= 3; exits++)
          for (let seed = 1; seed <= 25; seed++) {
            const spec = build(archetype, seed * 7919 + exits, side, exits);
            const problems = validateRoom(spec, gameData);
            expect(problems, `${archetype} seed ${seed} side ${side}: ${problems.join('; ')}`).toEqual([]);
            expect(spec.layout.doors.find((d) => d.entrance)?.side).toBe(side);
            rooms++;
          }
    expect(rooms).toBe(4 * 4 * 3 * 25);
  });

  it('furnishes rooms and gives every text surface some text', () => {
    for (const archetype of ARCHETYPES) {
      const spec = build(archetype, 42, 's', 2);
      expect(spec.props.length, archetype).toBeGreaterThan(2);
      for (const p of spec.props) {
        const recipe = gameData.props.find((r) => r.id === p.recipe)!;
        if (recipe.text) expect(p.surfaceText, `${p.recipe} text`).toBeTruthy();
      }
    }
  });

  it('places the spawn point inside the room, facing away from the entrance', () => {
    for (const side of SIDES) {
      const { layout } = build('waiting_room', 3, side, 2);
      expect(layout.spawn.x).toBeGreaterThan(0);
      expect(layout.spawn.x).toBeLessThan(layout.width);
      expect(layout.spawn.z).toBeGreaterThan(0);
      expect(layout.spawn.z).toBeLessThan(layout.depth);
      // Facing direction points into the room: one step forward stays inside.
      const fx = layout.spawn.x - Math.sin(layout.spawn.yaw) * 2;
      const fz = layout.spawn.z - Math.cos(layout.spawn.yaw) * 2;
      expect(fx > 0 && fx < layout.width && fz > 0 && fz < layout.depth, side).toBe(true);
    }
  });
});

describe('run', () => {
  it('starts in the waiting room with the button, and every later room is valid and new', () => {
    const run = new Run(1234, gameData);
    const first = run.start();
    expect(first.layout.archetype).toBe('waiting_room');
    expect(first.props.some((p) => p.recipe === 'button_pedestal')).toBe(true);
    const rng = createRng(9);
    for (let i = 0; i < 40; i++) {
      const exits = run.current!.layout.doors.filter((d) => !d.entrance);
      const room = run.next(exits[Math.floor(rng() * exits.length)]!.id);
      expect(validateRoom(room, gameData)).toEqual([]);
      expect(room.layout.archetype).not.toBe(run.rooms.at(-2)!.layout.archetype);
    }
    expect(new Set(run.rooms.map((r) => r.id)).size).toBe(41);
  });

  it('is reproducible from its seed', () => {
    const a = new Run(77, gameData), b = new Run(77, gameData);
    a.start(); b.start();
    expect(a.next('d1')).toEqual(b.next('d1'));
  });
});
