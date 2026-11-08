import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameData } from '../../core/data';
import { buildRoomMessages, pickModelSlots } from '../../core/director/content';
import { DIR, OPPOSITE } from '../../core/room/geometry';
import { generateLayout, LIFT } from '../../core/room/layouts';
import { placeAssignments } from '../../core/room/place';
import { templateAssignments } from '../../core/room/templates';
import { validateRoom } from '../../core/room/validate';
import type { RoomSpec, Side } from '../../core/room/types';
import type { RuleEffect } from '../../core/protocol';
import { liftRule, RuleRuntime } from '../../core/rules/rules';
import { createRng } from '../../core/util/random';
import { Run } from '../../core/run/run';
import { fakeLlm } from './fakeLlm';

const SIDES: Side[] = ['n', 's', 'e', 'w'];

function liftRoom(seed: number, side: Side): RoomSpec {
  const rng = createRng(seed);
  const layout = generateLayout({ archetype: 'lift_lobby', entranceSide: side, exits: 3, rng, doorLabels: gameData.templates.doorLabels });
  const { props } = placeAssignments(layout, templateAssignments(layout, gameData, rng, { index: 2 }), gameData);
  return { id: `lift-${seed}`, index: 2, seed, layout, props, ambience: 'cold', narrator: { onEnter: '', doors: {} }, source: 'template', title: 'x' };
}

describe('L and U rooms', () => {
  it('have a solid block that bends the room, and every exit stays reachable', () => {
    for (const archetype of ['l_gallery', 'u_gallery'] as const)
      for (const side of SIDES)
        for (let seed = 1; seed <= 20; seed++) {
          const layout = generateLayout({ archetype, entranceSide: side, exits: 3, rng: createRng(seed), doorLabels: gameData.templates.doorLabels });
          const solid = layout.cells.join('').split('#').length - 1;
          expect(solid, `${archetype} has a cut-out`).toBeGreaterThan(8);
          expect(layout.doors.filter((d) => !d.entrance).length).toBeGreaterThanOrEqual(1);
        }
  });
});

describe('lift lobby', () => {
  it('has a lift facing the player, a call button, and one MAINTENANCE exit in a side wall, from every direction', () => {
    for (const side of SIDES)
      for (let seed = 1; seed <= 30; seed++) {
        const room = liftRoom(seed, side);
        expect(validateRoom(room, gameData), `seed ${seed} side ${side}`).toEqual([]);
        const lift = room.props.find((p) => p.id === LIFT.doors)!;
        const call = room.props.find((p) => p.id === LIFT.call)!;
        expect(lift.recipe).toBe('lift_doors');
        expect(call.recipe).toBe('lift_call');
        expect(lift.surfaceText).toBe(LIFT.floors[0]);
        // The lift stands against the wall opposite the entrance and faces into the room.
        const far = OPPOSITE[side];
        const [fx, fz] = DIR[far];
        const { width: W, depth: D } = room.layout;
        if (fx) expect(Math.abs(lift.x - (fx > 0 ? W : 0))).toBeLessThan(0.3);
        if (fz) expect(Math.abs(lift.z - (fz > 0 ? D : 0))).toBeLessThan(0.3);
        const facing = [Math.round(Math.sin(lift.rotY)) || 0, Math.round(Math.cos(lift.rotY)) || 0];
        expect(facing).toEqual([-fx || 0, -fz || 0]);
        // One way on: the maintenance door, never on the lift's wall or the entrance wall.
        const exits = room.layout.doors.filter((d) => !d.entrance);
        expect(exits).toHaveLength(1);
        expect(exits[0]!.label).toBe(LIFT.exitLabel);
        expect(exits[0]!.fixedLabel).toBe(true);
        expect([side, far]).not.toContain(exits[0]!.side);
        // Ordinary props are numbered as before, around the fixtures.
        expect(room.props.filter((p) => p.slot !== 'fixture').map((p) => p.id)).toEqual(
          room.props.filter((p) => p.slot !== 'fixture').map((_, i) => `p${i + 1}`),
        );
      }
  });

  it('is never offered to the model as a prop, and the model is told about the lift', () => {
    const room = liftRoom(4, 'w');
    const rule = liftRule(room.layout, createRng(1));
    const slots = pickModelSlots(room.layout, gameData, createRng(2));
    const { messages, propIds } = buildRoomMessages(
      { index: 2, layout: room.layout, entranceLabel: 'X', story: [], behaviour: [], profile: [], rule, threads: [], runLength: 7, data: gameData },
      slots,
    );
    expect(propIds).not.toContain('lift_doors');
    expect(messages[0]!.content).not.toContain('lift_doors');
    expect(messages[1]!.content).toContain('The lift never arrives');
    expect(messages[1]!.content).toMatch(/labelled "MAINTENANCE"; keep that label/);
  });
});

describe('lift_wait rule', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const run = new Run(3, gameData, { observeMs: 60_000 });
    run.start();
    const room = liftRoom(7, 's');
    const effects: RuleEffect[] = [];
    const said: string[] = [];
    const door = room.layout.doors.find((d) => !d.entrance)!.id;
    const rt = new RuleRuntime(
      { id: 'lift_wait', params: { door, hintSeconds: 50 }, line: 'The lift is coming.', doneLine: 'Perhaps not.' },
      { room, profile: run.profile, emit: (e) => effects.push(e), say: (s) => said.push(s), rng: createRng(1), data: gameData },
    );
    return { run, room, rt, effects, said, door };
  }

  it('creeps the indicator down, never arrives, then hints after a long wait', () => {
    vi.useFakeTimers();
    const s = setup();
    s.rt.start(0);
    expect(s.said).toEqual(['The lift is coming.']);
    vi.advanceTimersByTime(49_000);
    const floors = s.effects.filter((e) => e.kind === 'display').map((e) => (e as Extract<RuleEffect, { kind: 'display' }>).text);
    expect(floors.slice(0, 6)).toEqual(['8', '7', '6', '5', '4', '3']);
    expect(new Set(floors.slice(6))).toEqual(new Set(['3', '4'])); // hovers, never lower than the last floor
    expect(s.said).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    expect(s.said.at(-1)).toBe('Perhaps not.');
    expect(s.run.profile.traits.hesitation).toBeGreaterThan(0.6);
    s.rt.stop();
    const n = s.effects.length;
    vi.advanceTimersByTime(30_000);
    expect(s.effects).toHaveLength(n);
  });

  it('reads button mashing as impulsive, and finding the door alone as decisive', () => {
    vi.useFakeTimers();
    const s = setup();
    s.rt.start(0);
    for (let i = 0; i < 5; i++) s.rt.onEvent({ type: 'pressed', roomId: s.room.id, objectId: LIFT.call, t: 2 + i });
    expect(s.said).toHaveLength(2); // a dry line on the third press
    expect(s.run.profile.traits.impulsivity).toBeGreaterThan(0.6);
    s.rt.onEvent({ type: 'door_chosen', roomId: s.room.id, doorId: s.door, t: 12 });
    expect(s.run.profile.traits.hesitation).toBeLessThan(0.5);
    expect(s.run.profile.evidence.at(-1)!.reason).toMatch(/maintenance door after 12 s/);
  });
});

describe('lift lobby in a run', () => {
  it('appears at most once per run, never as the final room, and always runs the lift rule', async () => {
    let seen = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const run = new Run(seed, gameData, { observeMs: 0 });
      run.start();
      const rng = createRng(seed);
      while (!run.finished) {
        const exits = run.current!.layout.doors.filter((d) => !d.entrance);
        await run.next(exits[Math.floor(rng() * exits.length)]!.id);
      }
      const lifts = run.rooms.filter((r) => r.layout.archetype === 'lift_lobby');
      expect(lifts.length).toBeLessThanOrEqual(1);
      expect(run.rooms.at(-1)!.layout.archetype).not.toBe('lift_lobby');
      // (A won 50/50 gamble takes away the next room's task, the lift's rule included.)
      for (const r of lifts) if (r.gambleResult !== 'shortcut') expect(r.rule?.id).toBe('lift_wait');
      for (const r of run.rooms) if (r.rule?.id === 'lift_wait') expect(r.layout.archetype).toBe('lift_lobby');
      seen += lifts.length;
    }
    expect(seen).toBeGreaterThan(10); // it does come up
  });

  it('?layout= forces room types, and the model cannot rename the maintenance door', async () => {
    const run = new Run(9, gameData, { llm: fakeLlm(), observeMs: 0, forceArchetypes: ['lift_lobby', 'l_gallery', 'u_gallery'] });
    run.start();
    // Room 1 holds a gamble (two doors), so the lift goes in the first room after it. Take the certain door.
    const first = await run.next('d1');
    expect(first.rule?.id).toBe('gamble');
    expect(first.layout.archetype).not.toBe('lift_lobby');
    const lift = await run.next(String(first.rule!.params.safe));
    expect(lift.layout.archetype).toBe('lift_lobby');
    expect(lift.source).toBe('model');
    expect(lift.rule?.id).toBe('lift_wait');
    expect(lift.layout.doors.find((d) => !d.entrance)!.label).toBe('MAINTENANCE');
    expect(lift.props.map((p) => p.id)).toEqual(expect.arrayContaining([LIFT.doors, LIFT.call]));
    expect(validateRoom(lift, gameData)).toEqual([]);
    expect((await run.next(lift.layout.doors.find((d) => !d.entrance)!.id)).layout.archetype).toBe('l_gallery');
    const l = run.current!;
    const next = l.rule?.id === 'gamble' ? String(l.rule.params.safe) : l.layout.doors.find((d) => !d.entrance)!.id;
    expect((await run.next(next)).layout.archetype).toBe('u_gallery');
  });

  it('pressing the lift button is not read as the waiting-room button', async () => {
    const run = new Run(9, gameData, { observeMs: 60_000, forceArchetypes: ['lift_lobby'] });
    run.start();
    let lift = run.current!;
    while (lift.layout.archetype !== 'lift_lobby') {
      const door = lift.rule?.id === 'gamble' ? String(lift.rule.params.safe) : lift.layout.doors.find((d) => !d.entrance)!.id;
      lift = await run.next(door);
    }
    run.record({ type: 'room_entered', roomId: lift.id, t: 100 });
    run.record({ type: 'pressed', roomId: lift.id, objectId: LIFT.call, t: 101 });
    expect(run.profile.evidence.filter((e) => /button/.test(e.reason))).toEqual([]);
  });
});
