import { describe, expect, it } from 'vitest';
import { corridorStory, createCorridor } from '../../core/corridors/corridor';
import { gameData } from '../../core/data';
import type { CoreMessage, GameEvent } from '../../core/protocol';
import { OPPOSITE, reachable } from '../../core/room/geometry';
import type { Side } from '../../core/room/types';
import { createCore } from '../../core/run/core';
import { Run } from '../../core/run/run';
import { fakeLlm } from './fakeLlm';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('playable passages', () => {
  it('connects every door orientation with a straight traversable passage and real interaction recipes', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const room = new Run(seed, gameData).start();
      for (const side of ['n', 's', 'e', 'w'] as Side[]) {
        const door = { ...room.layout.doors.find((d) => !d.entrance)!, side };
        const spec = createCorridor(room, door, corridorStory(room, door, [], gameData), gameData);
        const [entry, exit] = spec.layout.doors;
        expect(entry!.side).toBe(OPPOSITE[side]);
        expect(exit!.side).toBe(side);
        expect(reachable(spec.layout, [entry!.cx, entry!.cz], new Set()).has(`${exit!.cx},${exit!.cz}`)).toBe(true);
        expect(spec.props.every((p) => gameData.props.some((r) => r.id === p.recipe))).toBe(true);
        expect(spec.corridor!.windows.length).toBeGreaterThanOrEqual(4);
        expect(new Set(spec.corridor!.windows.map((w) => w.side)).size).toBe(2);
        expect(side === 'n' || side === 's' ? entry!.cx === exit!.cx : entry!.cz === exit!.cz).toBe(true);
        expect(spec.props.length).toBeGreaterThanOrEqual(4); // 3 optional objects + interlock
        expect(spec.props.length).toBeLessThanOrEqual(6);
        expect(spec.rule).toBeUndefined();
        expect(spec.anomaly).toBeUndefined();
      }
    }
  });

  it('replays seeded selections and includes all event types as well as quiet corridors', () => {
    const events = new Set<string>(), recipes = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const room = new Run(seed, gameData).start(), door = room.layout.doors.find((d) => !d.entrance)!;
      const story = corridorStory(room, door, [], gameData);
      const spec = createCorridor(room, door, story, gameData);
      expect(createCorridor(room, door, story, gameData)).toEqual(spec);
      events.add(spec.corridor!.event?.kind ?? 'none');
      spec.props.forEach((p) => recipes.add(p.recipe));
    }
    expect([...events].sort()).toEqual(['breaking_window', 'falling_art', 'none', 'paper_gust']);
    for (const recipe of gameData.props.filter((p) => p.inspectable || p.interact)) expect(recipes.has(recipe.id), recipe.id).toBe(true);
  });

  it('uses the selected door and observed actions, without inventing inspection or button presses', () => {
    const room = new Run(12, gameData).start();
    const door = room.layout.doors.find((d) => !d.entrance)!;
    const empty = corridorStory(room, door, [], gameData);
    expect(empty.entry).toContain(door.label);
    expect(empty.receipt).toContain('Objects inspected: 0');
    const events: GameEvent[] = [
      { type: 'pressed', roomId: room.id, objectId: 'button', t: 2 },
      { type: 'pressed', roomId: room.id, objectId: 'button', t: 3 },
      { type: 'inspected', roomId: 'different-room', objectId: 'x', t: 4 },
    ];
    expect(corridorStory(room, door, events, gameData).entry).toContain('pressed 2 times');
    const prop = room.props.find((p) => gameData.props.find((r) => r.id === p.recipe)?.inspectable)!;
    events.push({ type: 'inspected', roomId: room.id, objectId: prop.id, t: 5 });
    expect(corridorStory(room, door, events, gameData).entry).toContain('stopped to examine');
    room.fact = 'The ceiling keeps a second copy of each file.';
    expect(corridorStory(room, door, events, gameData).archive).toContain(room.fact);
  });

  it('prepares in the background, commits only on physical arrival, and counts each choice once', async () => {
    const core = createCore(gameData, { corridors: true, observeMs: 60000, maxAnomalies: 0 });
    const messages: CoreMessage[] = [];
    core.onMessage((m) => messages.push(m));
    core.send({ type: 'run_started', seed: 3, t: 0 });
    const first = core.run()!.current!;
    core.send({ type: 'room_entered', roomId: first.id, t: 1 });
    const choice = { type: 'door_chosen', roomId: first.id, doorId: 'd1', t: 3 } as const;
    core.send(choice);
    core.send(choice);
    await tick();
    const ready = messages.find((m) => m.type === 'corridor_ready');
    expect(ready?.type).toBe('corridor_ready');
    expect(core.run()!.rooms).toHaveLength(1);
    expect(core.run()!.events.filter((e) => e.type === 'door_chosen')).toHaveLength(1);
    const traits = { ...core.run()!.profile.traits };
    const lines = messages.filter((m) => m.type === 'narrator_line').length;
    for (let i = 0; i < 3; i++) core.send({ type: 'corridor_interacted', roomId: first.id, objectId: 'acknowledge', t: 4 + i });
    expect(core.run()!.profile.traits).toEqual(traits);
    expect(messages.filter((m) => m.type === 'narrator_line')).toHaveLength(lines + 1);
    expect(core.run()!.ruleStarts.size).toBe(0);
    core.send({ type: 'corridor_exited', roomId: first.id, t: 10 });
    expect(core.run()!.rooms).toHaveLength(2);
    const second = core.run()!.current!;
    expect(ready?.type === 'corridor_ready' && ready.spec.id).toBe(second.id);
    expect(messages.filter((m) => m.type === 'load_room')).toHaveLength(1);
    core.send(choice); // late click from the old room cannot leave the new room
    expect(core.run()!.current).toBe(second);
  });

  it.each([{ exitWait: 500, source: 'model' }, { exitWait: 30, source: 'template' }])('keeps generation alive at the exit, bounded by $exitWait ms ($source)', async ({ exitWait, source }) => {
    const core = createCore(gameData, { corridors: true, llm: fakeLlm({ delayMs: 150 }), observeMs: 60000, waitMs: 60000, corridorExitWaitMs: exitWait, layout: { pool: ['exit_timer'] } });
    const messages: CoreMessage[] = [];
    core.onMessage((m) => messages.push(m));
    core.send({ type: 'run_started', seed: 12, t: 0 });
    const roomId = core.run()!.current!.id;
    core.send({ type: 'door_chosen', roomId, doorId: 'd1', t: 1 });
    core.send({ type: 'corridor_exit_requested', roomId, t: 2 });
    await tick(10);
    expect(messages.filter((m) => m.type === 'corridor_ready')).toHaveLength(0);
    core.send({ type: 'corridor_exit_requested', roomId, t: 2.1 });
    expect(messages.filter((m) => m.type === 'narrator_line' && m.text.includes('not released the interlock'))).toHaveLength(1);
    await tick(180);
    const ready = messages.find((m) => m.type === 'corridor_ready');
    expect(ready?.type === 'corridor_ready' && ready.spec.source).toBe(source);
    expect(ready?.type === 'corridor_ready' && ready.timing!.exitWaitMs).toBeGreaterThan(0);
    core.send({ type: 'corridor_exited', roomId, t: 3 });
    const arrived = core.run()!.current;
    await tick(180);
    expect(core.run()!.current).toBe(arrived);
    expect(messages.filter((m) => m.type === 'corridor_ready')).toHaveLength(1);
  });
});
