import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { validateRoom } from '../../core/room/validate';
import { createCore } from '../../core/run/core';
import type { CoreMessage } from '../../core/protocol';
import { Run } from '../../core/run/run';
import { fakeLlm } from './fakeLlm';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('model-generated rooms', () => {
  it('uses the model content: props, text, door labels, narrator lines, story memory', async () => {
    const calls: { user: string }[] = [];
    // No choice room in the pool: it is written from templates, so it wouldn't add a fact to the story.
    const run = new Run(4, gameData, { llm: fakeLlm({ calls }), observeMs: 0, maxAnomalies: 0, layout: { pool: ['exit_timer', 'lights_dim_on_idle', 'inspect_to_unlock'] } });
    const first = run.start();
    run.record({ type: 'room_entered', roomId: first.id, t: 0 });
    run.record({ type: 'inspected', roomId: first.id, objectId: first.props[0]!.id, t: 12 });
    const room = await run.next('d1');
    expect(room.source).toBe('model');
    expect(room.title).toBe('The Room of Second Thoughts');
    expect(room.ambience).toBe('warm');
    expect(room.props.some((p) => p.surfaceText === 'YOU HESITATED')).toBe(true);
    expect(room.layout.doors.filter((d) => !d.entrance).every((d) => d.label.startsWith('DOOR'))).toBe(true);
    expect(validateRoom(room, gameData)).toEqual([]);
    // The prompt carried what the player did.
    expect(calls[0]!.user).toContain('Inspected');
    // The next prompt carries the story so far.
    await run.next(run.current!.layout.doors.find((d) => !d.entrance)!.id);
    expect(calls.at(-1)!.user).toContain('The building keeps a record of every pause.');
  });

  it('repairs a bad answer once', async () => {
    const run = new Run(6, gameData, { llm: fakeLlm({ mode: 'bad-then-good' }), observeMs: 0 });
    run.start();
    expect((await run.next('d1')).source).toBe('model');
  });

  it('falls back to templates when the model keeps failing, and stops calling a server that is down', async () => {
    const bad = new Run(7, gameData, { llm: fakeLlm({ mode: 'always-bad' }), observeMs: 0 });
    bad.start();
    const room = await bad.next('d1');
    expect(room.source).toBe('template');
    expect(validateRoom(room, gameData)).toEqual([]);

    const down = new Run(8, gameData, { llm: fakeLlm({ mode: 'down' }), observeMs: 0 });
    down.start();
    expect((await down.next('d1')).source).toBe('template');
    expect(down.modelOff).toBe(true);
  });

  it('does not keep the player waiting: slow generation falls back after waitMs', async () => {
    const run = new Run(12, gameData, { llm: fakeLlm({ delayMs: 400 }), observeMs: 0, waitMs: 50 });
    run.start();
    const t0 = Date.now();
    const room = await run.next('d1');
    expect(Date.now() - t0).toBeLessThan(300);
    expect(room.source).toBe('template');
  });

  it('watches the player first, then generates the door they linger at first', async () => {
    const run = new Run(10, gameData, { llm: fakeLlm({ delayMs: 20 }), observeMs: 60_000 });
    const first = run.start();
    await tick(10);
    expect(run.plansStatus().every((p) => p.status === 'queued')).toBe(true);
    const last = first.layout.doors.filter((d) => !d.entrance).at(-1)!.id;
    run.record({ type: 'door_hovered', roomId: first.id, doorId: last, seconds: 1.6, t: 5 });
    await tick(5);
    expect(run.plansStatus().find((p) => p.door === last)!.status).toBe('generating');
  });
});

describe('core port', () => {
  it('streams a live reaction, then loads the room and says its entry line', async () => {
    const core = createCore(gameData, { llm: fakeLlm(), observeMs: 0 });
    const msgs: CoreMessage[] = [];
    core.onMessage((m) => msgs.push(m));
    core.send({ type: 'run_started', seed: 11, t: 0 });
    await tick(30); // rooms behind the doors get generated
    expect(msgs.some((m) => m.type === 'gen_status' && m.doors.every((d) => d.status === 'ready'))).toBe(true);
    core.send({ type: 'door_chosen', roomId: core.run()!.current!.id, doorId: 'd1', t: 20 });
    await tick(30);
    const lines = msgs.filter((m) => m.type === 'narrator_line') as Extract<CoreMessage, { type: 'narrator_line' }>[];
    expect(lines.some((l) => !l.final && l.text === 'Interesting')).toBe(true);
    expect(lines.at(-1)!.text).toBe(core.run()!.current!.narrator.onEnter);
    expect(msgs.filter((m) => m.type === 'load_room')).toHaveLength(2);
  });
});

describe('parallel generation', () => {
  it('generates every door at once when the server allows it', async () => {
    const run = new Run(12, gameData, { llm: fakeLlm({ delayMs: 60 }), observeMs: 0, concurrency: 3, runLength: 60 });
    // Walk until a room has 3 exits.
    run.start();
    while (run.current!.layout.doors.filter((d) => !d.entrance).length < 3) await run.next('d1');
    await tick(5);
    const status = run.plansStatus();
    expect(status.filter((p) => p.status === 'generating')).toHaveLength(3);
    const t0 = Date.now();
    await run.next(status.at(-1)!.door);
    expect(Date.now() - t0).toBeLessThan(150); // one request's time, not three
  });

  it('keeps one at a time by default, lingered-at door first', async () => {
    const run = new Run(13, gameData, { llm: fakeLlm({ delayMs: 30 }), observeMs: 0 });
    run.start();
    await tick(5);
    expect(run.plansStatus().filter((p) => p.status === 'generating')).toHaveLength(1);
  });
});
