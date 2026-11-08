import { afterEach, describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { Profile } from '../../core/profile/profile';
import type { GameEvent } from '../../core/protocol';
import { FINALE_HALL, generateLayout } from '../../core/room/layouts';
import type { Side } from '../../core/room/types';
import { validateRoom } from '../../core/room/validate';
import { createCore } from '../../core/run/core';
import { Run, type RunOptions } from '../../core/run/run';
import { resolveLayout } from '../../core/testrooms/config';
import { TEST_KINDS, TESTS } from '../../core/testrooms/registry';
import { pickRoom } from '../../core/testrooms/schedule';
import type { TestKind } from '../../core/testrooms/types';
import { createRng } from '../../core/util/random';
import { fakeLlm } from './fakeLlm';

/** Plays a run to the finale, choosing doors at random (the 50/50 door included). */
async function play(seed: number, opts: RunOptions = {}) {
  const run = new Run(seed, gameData, { observeMs: 0, waitMs: 100, ...opts });
  run.start();
  const rng = createRng(seed * 31);
  while (!run.finished) {
    const exits = run.current!.layout.doors.filter((d) => !d.entrance);
    await run.next(exits[Math.floor(rng() * exits.length)]!.id);
  }
  return run;
}

const count = (run: Run, slot: string) => run.rooms.filter((r) => r.slot === slot).length;

describe('run layout', () => {
  it('always has exactly the configured test and filler rooms, then the finale hallway', async () => {
    for (const [tests, fillers] of [[4, 1], [2, 3], [6, 0], [0, 2]] as const) {
      for (let seed = 1; seed <= 30; seed++) {
        const run = await play(seed, { layout: { tests, fillers } });
        const detours = run.gambles.filter((g) => g.outcome === 'setback').length;
        expect(run.rooms[0]!.slot).toBe('start');
        expect(count(run, 'test'), `seed ${seed}`).toBe(tests);
        expect(count(run, 'filler'), `seed ${seed}`).toBe(fillers + detours); // a lost gamble adds one filler
        expect(run.rooms).toHaveLength(tests + fillers + detours + 2);
        const finale = run.rooms.at(-1)!;
        expect(finale.slot).toBe('finale');
        expect(finale.layout.archetype).toBe(FINALE_HALL);
        expect(finale.rule).toBeUndefined();
        const exits = finale.layout.doors.filter((d) => !d.entrance);
        expect(exits).toHaveLength(1);
        expect(exits[0]!.finale).toBe(true);
        for (const r of run.rooms) expect(validateRoom(r, gameData), `${r.layout.archetype} ${r.index}`).toEqual([]);
        for (const r of run.rooms.filter((x) => x.slot === 'filler')) expect(r.rule).toBeUndefined();
      }
    }
  });

  it('decides the order as the player goes: test and filler rooms land in different places run to run', async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) orders.add((await play(seed, { layout: { tests: 3, fillers: 2, pool: ['exit_timer', 'lights_dim_on_idle'] } })).rooms.map((r) => r.slot![0]).join(''));
    expect(orders.size).toBeGreaterThan(4);
  });

  it('only draws tests from the pool, respects caps, and never repeats a test in back-to-back rooms', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const run = await play(seed, { layout: { tests: 5, fillers: 0, pool: { exit_timer: 1, lift_wait: 5, narrator_suggests: 1 } } });
      const tests = run.rooms.filter((r) => r.slot === 'test').map((r) => r.test);
      for (const t of tests) expect(['exit_timer', 'lift_wait', 'narrator_suggests']).toContain(t);
      expect(tests.filter((t) => t === 'lift_wait').length).toBeLessThanOrEqual(1); // the lift's own cap
      tests.forEach((t, i) => i && expect(t, `seed ${seed}`).not.toBe(tests[i - 1]));
    }
  });

  it('a pool of one test still fills every test room (repeats are allowed when nothing else is left)', async () => {
    const run = await play(5, { layout: { tests: 3, fillers: 0, pool: ['lights_dim_on_idle'] } });
    expect(run.rooms.filter((r) => r.slot === 'test').map((r) => r.test)).toEqual(['lights_dim_on_idle', 'lights_dim_on_idle', 'lights_dim_on_idle']);
  });

  it('draws tests that push against the player: hesitant players get more countdowns', () => {
    const profile = new Profile(gameData);
    profile.traits.hesitation = 0.95;
    const config = resolveLayout(gameData.layout, { tests: 5, fillers: 0, pool: ['exit_timer', 'inspect_to_unlock'] });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 400; i++) {
      const pick = pickRoom({ config, rooms: [], index: 1, last: 6, detours: 0, profile }, createRng(i));
      counts[pick.test!.id] = (counts[pick.test!.id] ?? 0) + 1;
    }
    expect(counts.exit_timer).toBeGreaterThan(counts.inspect_to_unlock! * 1.5);
  });

  it('builds a test room from one of that test\'s candidate layouts, with the doors it needs', () => {
    const config = resolveLayout(gameData.layout, { tests: 4, fillers: 0, pool: ['gamble', 'exit_timer', 'lift_wait', 'choice'] });
    for (let i = 0; i < 200; i++) {
      const pick = pickRoom({ config, rooms: [], index: 1, last: 5, detours: 0, profile: new Profile(gameData) }, createRng(i));
      const kind = pick.test!;
      expect(kind.candidates.map((c) => c.archetype)).toContain(pick.archetype);
      if (kind.id === 'gamble') expect(pick.exits).toBe(2);
      if (kind.id === 'exit_timer') expect(pick.exits).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads the old ?rooms=N as N rooms: waiting room, as many tests as configured, fillers, finale', () => {
    expect(resolveLayout(gameData.layout, {}, 7)).toMatchObject({ tests: 4, fillers: 1 });
    expect(resolveLayout(gameData.layout, {}, 4)).toMatchObject({ tests: 2, fillers: 0 });
    expect(resolveLayout(gameData.layout, {}, 10)).toMatchObject({ tests: 4, fillers: 4 });
    expect(resolveLayout(gameData.layout, { tests: 1, fillers: 1 }, 10)).toMatchObject({ tests: 1, fillers: 1 });
    // A list of ids keeps the data file's weights and caps; unknown ids are dropped.
    expect(resolveLayout(gameData.layout, { pool: ['gamble', 'nope'] }).pool).toEqual({ gamble: { weight: 1, max: 2 } });
  });

  it('builds a valid finale hallway from every direction', () => {
    for (const side of ['n', 's', 'e', 'w'] as Side[])
      for (let seed = 1; seed <= 20; seed++) {
        const layout = generateLayout({ archetype: FINALE_HALL, entranceSide: side, exits: 3, rng: createRng(seed), doorLabels: [] });
        const spec = { id: 'f', index: 6, seed, layout, props: [], ambience: 'cold', narrator: { onEnter: '', doors: {} }, source: 'template' as const, title: 'f' };
        expect(validateRoom(spec, gameData)).toEqual([]);
        expect(layout.doors.filter((d) => d.finale)).toHaveLength(1);
      }
  });

  it('tells the model about the glowing door in the finale', async () => {
    const calls: { user: string }[] = [];
    const run = new Run(2, gameData, { llm: fakeLlm({ calls }), observeMs: 0, layout: { tests: 0, fillers: 0 } });
    run.start();
    const finale = await run.next('d1');
    expect(finale.slot).toBe('finale');
    expect(calls.at(-1)!.user).toMatch(/glowing warmer and brighter than any door so far/);
  });
});

describe('adding a test', () => {
  const extra: TestKind = {
    id: 'hum_test',
    candidates: [{ archetype: 'corridor', exits: 1 }],
    params: () => ({ pitch: 3 }),
    describe: (p) => `A hum at pitch ${p.pitch}.`,
    start: (h) => h.say(`hum ${h.rule.params.pitch}`),
    onEvent: (h, e) => { if (e.type === 'door_chosen') h.profile.adjust('curiosity', 0.1, 'left the hum behind', h.room, e.t); },
  };
  afterEach(() => {
    TEST_KINDS.splice(TEST_KINDS.indexOf(extra), 1);
    delete TESTS[extra.id];
  });

  it('takes a TestKind in the registry, a pool entry and template lines: nothing else', async () => {
    TEST_KINDS.push(extra);
    TESTS[extra.id] = extra;
    const data = { ...gameData, templates: { ...gameData.templates, rules: { ...gameData.templates.rules, hum_test: { line: ['Listen.'], done: ['Quiet.'] } } } };
    const said: string[] = [];
    const core = createCore(data, { observeMs: 0, layout: { tests: 1, fillers: 0, pool: ['hum_test'] } });
    core.onMessage((m) => m.type === 'narrator_line' && said.push(m.text));
    core.send({ type: 'run_started', seed: 1, t: 0 });
    const run = core.run()!;
    const room = await run.next('d1');
    expect(room).toMatchObject({ slot: 'test', test: 'hum_test', rule: { id: 'hum_test', params: { pitch: 3 }, line: 'Listen.' } });
    expect(room.layout.archetype).toBe('corridor');
    run.startRule(1);
    expect(said).toContain('hum 3');
    run.record({ type: 'room_entered', roomId: room.id, t: 1 } as GameEvent);
    run.record({ type: 'door_chosen', roomId: room.id, doorId: 'd1', t: 9 });
    expect(run.profile.evidence.at(-1)!.reason).toBe('left the hum behind');
  });
});
