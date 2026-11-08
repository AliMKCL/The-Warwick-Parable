import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { GameEvent, RuleEffect } from '../../core/protocol';
import { RuleRuntime, type RoomRule } from '../../core/rules/rules';
import { createRng } from '../../core/util/random';
import { Run } from '../../core/run/run';
import { fakeLlm } from './fakeLlm';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstRoom() {
  const run = new Run(3, gameData, { observeMs: 60_000 });
  return { run, room: run.start() };
}

describe('profile', () => {
  it('reads a long wait before the button as hesitation, and a quick press as impulsivity', () => {
    for (const [delay, trait] of [[22, 'hesitation'], [2, 'impulsivity']] as const) {
      const { run, room } = firstRoom();
      const button = room.props.find((p) => p.recipe === 'button_pedestal')!;
      run.record({ type: 'room_entered', roomId: room.id, t: 0 });
      run.record({ type: 'pressed', roomId: room.id, objectId: button.id, t: delay });
      expect(run.profile.traits[trait]).toBeGreaterThan(0.6);
      expect(run.profile.evidence.some((e) => /button/.test(e.reason))).toBe(true);
    }
  });

  it('caps how far one room can move a trait, and explains every change', () => {
    const { run, room } = firstRoom();
    run.record({ type: 'room_entered', roomId: room.id, t: 0 });
    for (let i = 0; i < 20; i++) run.record({ type: 'inspected', roomId: room.id, objectId: room.props[i % room.props.length]!.id, t: i });
    expect(run.profile.traits.curiosity).toBeLessThanOrEqual(0.75 + 1e-9);
    expect(run.profile.evidence.every((e) => e.reason.length > 5)).toBe(true);
    expect(run.describe(room).some((l) => l.startsWith('Noticed:'))).toBe(true);
  });
});

describe('rules at runtime', () => {
  function setup(rule: RoomRule) {
    const { run, room } = firstRoom();
    const effects: RuleEffect[] = [];
    const said: string[] = [];
    const rt = new RuleRuntime(rule, { room, profile: run.profile, emit: (e) => effects.push(e), say: (s) => said.push(s), rng: createRng(1), data: gameData });
    const ev = (e: Omit<GameEvent, 'roomId'> & { type: GameEvent['type'] }) => rt.onEvent({ ...e, roomId: room.id } as GameEvent);
    return { run, room, rt, effects, said, ev, exits: room.layout.doors.filter((d) => !d.entrance).map((d) => d.id) };
  }

  it('inspect_to_unlock: locks every exit until enough things are inspected', () => {
    const s = setup({ id: 'inspect_to_unlock', params: { count: 2 }, line: 'Look around.', doneLine: 'Open.' });
    s.rt.start(0);
    expect(s.effects[0]).toEqual({ kind: 'doors', locked: s.exits });
    s.ev({ type: 'door_tried', doorId: s.exits[0]!, t: 1 } as any);
    expect(s.run.profile.traits.impulsivity).toBeGreaterThan(0.5);
    const inspectable = s.room.props.filter((p) => gameData.props.find((r) => r.id === p.recipe)?.inspectable);
    s.ev({ type: 'inspected', objectId: inspectable[0]!.id, t: 2 } as any);
    s.ev({ type: 'inspected', objectId: inspectable[0]!.id, t: 3 } as any); // same thing twice doesn't count
    expect(s.effects).toHaveLength(1);
    s.ev({ type: 'inspected', objectId: inspectable[1]!.id, t: 4 } as any);
    expect(s.effects.at(-1)).toEqual({ kind: 'doors', locked: [] });
    expect(s.said).toEqual(['Look around.', expect.any(String), 'Open.']);
  });

  it('exit_timer: counts down, then locks all exits but one', async () => {
    const s = setup({ id: 'exit_timer', params: { seconds: 0.05 }, line: 'Hurry.', doneLine: 'Too late.' });
    s.rt.start(0);
    expect(s.effects[0]).toMatchObject({ kind: 'timer', seconds: 0.05 });
    await sleep(90);
    const doors = s.effects.find((e) => e.kind === 'doors') as Extract<RuleEffect, { kind: 'doors' }>;
    expect(doors.locked).toHaveLength(s.exits.length - 1);
    expect(s.said.at(-1)).toBe('Too late.');
    expect(s.run.profile.traits.hesitation).toBeGreaterThan(0.6);
  });

  it('lights_dim_on_idle: dims when the player stands still and recovers when they move', async () => {
    const s = setup({ id: 'lights_dim_on_idle', params: { idleSeconds: 0.03 }, line: 'Lights out.', doneLine: '' });
    s.rt.start(0);
    s.ev({ type: 'motion', moving: false, t: 1 } as any);
    await sleep(60);
    expect(s.effects.at(-1)).toMatchObject({ kind: 'lights', level: 0.12 });
    s.ev({ type: 'motion', moving: true, t: 2 } as any);
    expect(s.effects.at(-1)).toMatchObject({ kind: 'lights', level: 1 });
  });

  it('narrator_suggests: following or ignoring the advice moves compliance', () => {
    const a = setup({ id: 'narrator_suggests', params: { door: 'd1', lie: 1 }, line: 'Take d1.', doneLine: '' });
    a.rt.start(0);
    a.ev({ type: 'door_chosen', doorId: 'd1', t: 5 } as any);
    expect(a.run.profile.traits.compliance).toBeGreaterThan(0.6);
    expect(a.run.profile.evidence.at(-1)!.reason).toMatch(/lying/);
    const b = setup({ id: 'narrator_suggests', params: { door: 'd1', lie: 0 }, line: 'Take d1.', doneLine: '' });
    b.rt.start(0);
    b.ev({ type: 'door_chosen', doorId: 'd2', t: 5 } as any);
    expect(b.run.profile.traits.compliance).toBeLessThan(0.4);
  });
});

describe('story across a run', () => {
  it('plants threads, offers them to later rooms, and ends with a single way on', async () => {
    const calls: { user: string }[] = [];
    const run = new Run(21, gameData, { llm: fakeLlm({ calls }), observeMs: 0 });
    run.start();
    let room;
    while (!run.finished) room = await run.next(run.current!.layout.doors.find((d) => !d.entrance)!.id);
    expect(run.threads.length).toBeGreaterThan(0);
    expect(calls.some((c) => /^- t1: Someone else has your badge\./m.test(c.user))).toBe(true);
    expect(run.threads.some((t) => t.resolvedIn !== undefined)).toBe(true);
    expect(room!.index).toBe(run.last);
    expect(room!.slot).toBe('finale');
    expect(room!.layout.doors.filter((d) => !d.entrance)).toHaveLength(1);
    expect(room!.rule).toBeUndefined();
    // Rooms with rules carry the model's lines for them.
    for (const r of run.rooms.filter((x) => x.rule)) expect(r.rule!.line).toBe('There is a rule here.');
  });
});

describe('rules pick up the current state', () => {
  it('lights_dim_on_idle dims if the player was already standing still when it started', async () => {
    const run = new Run(3, gameData, { observeMs: 60_000 });
    const room = run.start();
    const effects: RuleEffect[] = [];
    const rt = new RuleRuntime({ id: 'lights_dim_on_idle', params: { idleSeconds: 0.03 }, line: 'x', doneLine: '' }, {
      room, profile: run.profile, emit: (e) => effects.push(e), say: () => {}, rng: createRng(1), data: gameData,
    });
    rt.start(5, [{ type: 'motion', roomId: room.id, moving: false, t: 2 }]);
    await sleep(60);
    expect(effects.at(-1)).toMatchObject({ kind: 'lights', level: 0.12 });
  });
});
