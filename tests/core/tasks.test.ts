import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { GameEvent, RuleEffect, TaskEvent } from '../../core/protocol';
import { placeAssignments } from '../../core/room/place';
import { templateAssignments } from '../../core/room/templates';
import type { Door, RoomSpec, Side } from '../../core/room/types';
import { validateRoom } from '../../core/room/validate';
import { Run } from '../../core/run/run';
import { buildTaskLayout } from '../../core/tasks/layouts';
import { computeBaseline, robustZ, scoreTask } from '../../core/tasks/metrics';
import { OFFICE_TASKS, sessionParams, taskFor, type TaskId } from '../../core/tasks/params';
import { createRng } from '../../core/util/random';

const SIDES: Side[] = ['n', 's', 'e', 'w'];

describe('office task layouts', () => {
  it('are playable in every orientation, with fixtures and zones inside the room', () => {
    for (const id of OFFICE_TASKS)
      for (const side of SIDES)
        for (let seed = 1; seed <= 12; seed++) {
          const params = { ...sessionParams(seed)[id], ...(id === 'smoke' ? { condition: seed % 2 ? 'crowd' : 'alone' } : {}), ...(id === 'lift' && seed % 3 === 0 ? { stairs: 'tucked' } : {}), ...(id === 'desk' ? { items: 3 + (seed % 4), offset: seed % 2 ? 'near' : 'far' } : {}) };
          const rng = createRng(seed * 31);
          const { layout } = buildTaskLayout(id, params, side, rng, gameData);
          const { props } = placeAssignments(layout, templateAssignments(layout, gameData, rng, { index: 1 }), gameData);
          const spec: RoomSpec = { id: 'x', index: 1, seed, layout, props, ambience: 'cold', narrator: { onEnter: '', doors: {} }, source: 'template', title: 'x' };
          const where = `${id} seed ${seed} side ${side}`;
          expect(validateRoom(spec, gameData), where).toEqual([]);
          expect(layout.doors.find((d) => d.entrance)?.side, where).toBe(side);
          for (const f of layout.fixtures ?? []) {
            expect(props.some((p) => p.id === f.id), `${where}: fixture ${f.id} placed`).toBe(true);
            expect(f.x >= 0 && f.x <= layout.width && f.z >= 0 && f.z <= layout.depth, `${where}: ${f.id} inside`).toBe(true);
          }
          for (const z of layout.zones ?? []) expect(z.x >= -0.5 && z.x <= layout.width + 0.5 && z.z >= -0.5 && z.z <= layout.depth + 0.5, `${where}: zone ${z.id}`).toBe(true);
        }
  });

  it('puts the "left" door on the player\'s left, whichever way the room is turned', () => {
    for (const side of SIDES) {
      const { layout, params } = buildTaskLayout('two_doors', { instructedSide: 'left', lineVariant: 0 }, side, createRng(5), gameData);
      const { x, z, yaw } = layout.spawn;
      const right = [Math.cos(yaw), -Math.sin(yaw)] as const; // the player's right-hand direction at spawn
      const door = (id: unknown) => layout.doors.find((d) => d.id === id)!;
      const lateral = (d: Door) => (d.cx + 0.5 - x) * right[0] + (d.cz + 0.5 - z) * right[1];
      expect(lateral(door(params.leftDoor)), side).toBeLessThan(0);
      expect(lateral(door(params.rightDoor)), side).toBeGreaterThan(0);
      expect(door(params.allowedDoor).label).toBe(gameData.tasks.two_doors.allowedLabel);
      expect(door(params.forbiddenDoor).label).toBe(gameData.tasks.two_doors.forbiddenLabel);
    }
  });

  it('stages the tasks in rooms 1 to 5, in order, and cuts the last ones in short runs', () => {
    expect([1, 2, 3, 4, 5].map((i) => taskFor(i, 6))).toEqual(OFFICE_TASKS);
    expect(taskFor(0, 6)).toBeUndefined();
    expect(taskFor(6, 6)).toBeUndefined();
    expect([1, 2, 3, 4].map((i) => taskFor(i, 4))).toEqual(['two_doors', 'lift', 'desk', undefined]);
  });
});

// ---------- metrics on hand-made logs ----------

const ev = (t: number, task: string, type: string, data: Record<string, unknown> = {}): TaskEvent => ({ t, task, type, data });
const moves = (task: string, from: number, to: number, path: (t: number) => [number, number]) => {
  const out: TaskEvent[] = [];
  let prev: [number, number, number] | undefined;
  for (let t = from; t <= to + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
    const [x, z] = path(t);
    const vx = prev ? (x - prev[1]) / (t - prev[0]) : 0, vz = prev ? (z - prev[2]) / (t - prev[0]) : 0;
    out.push(ev(t, task, 'move', { x, z, vx, vz }));
    prev = [t, x, z];
  }
  return out;
};

describe('office task metrics', () => {
  it('robust z-scores use the baseline median and MAD, with a floor on the scale', () => {
    expect(robustZ(3, 1, 1, 0.1)).toBeCloseTo(2 / 1.4826);
    expect(robustZ(3, 1, 0, 0.5)).toBe(4);
    expect(robustZ(null, 1, 1, 0.1)).toBeNull();
    expect(robustZ(2, null, null, 0.1)).toBeNull();
  });

  it('measures the baseline: speed, idle share, input rate and reaction time', () => {
    const log = [
      ev(0, 'baseline', 'task_start'),
      ...moves('baseline', 0, 10, (t) => (t < 5 ? [1 + t * 1.5, 1] : [8.5, 1])),
      ev(1, 'baseline', 'input', { key: 'KeyW' }),
      ev(2, 'baseline', 'input', { key: 'KeyD' }),
      ev(6, 'baseline', 'prompt_shown', { prompt: 'p1' }),
      ev(6.8, 'baseline', 'input', { key: 'KeyE', target: 'p1' }),
      ev(10, 'baseline', 'task_end'),
    ];
    const b = computeBaseline(log);
    expect(b.speed).toBeCloseTo(1.5, 1);
    expect(b.idleShare).toBeGreaterThan(0.4);
    expect(b.idleShare).toBeLessThan(0.6);
    expect(b.reaction).toBeCloseTo(0.8, 5);
    expect(b.inputRate).toBeCloseTo(2 / 5, 1);
  });

  const base = { speed: 1.5, speedMad: 0.1, inputRate: 1, idleShare: 0.3, activity: 0.8, reaction: 1, reactionMad: 0.2, turns: 0, turnsMad: 0, samples: 100 };

  it('two doors: compliance, latency against the baseline, early action, forbidden approaches', () => {
    const params = { instructedSide: 'left', leftDoor: 'd1', rightDoor: 'd2' };
    const common = [ev(0, 'two_doors', 'task_start'), ev(0.5, 'two_doors', 'narrator_start', { line: 'instruction' }), ev(5.5, 'two_doors', 'narrator_end', { line: 'instruction' })];
    // Waits for the line, then walks to the left door.
    const good = scoreTask('two_doors', [...common, ...moves('two_doors', 0, 9, (t) => (t < 6 ? [3.5, 5] : [3.5 - (t - 6), 5 - (t - 6)])), ev(9, 'two_doors', 'zone_enter', { zone: 'door_left' }), ev(9.5, 'two_doors', 'choice', { prompt: 'door', chosen: 'left' })], { params, baseline: base, all: [] });
    expect(good.metrics.compliance).toBe(1);
    expect(good.metrics.compliance_latency).toBeCloseTo(4);
    expect(good.metrics.compliance_latency_z).toBeCloseTo(3 / Math.max(1.4826 * 0.2, 0.25), 1);
    expect(good.metrics.early_action).toBe(0);
    expect(good.metrics.forbidden_approaches).toBe(0);
    // Walks off at once, visits the maintenance door twice, leaves through it before the line ends.
    const bad = scoreTask('two_doors', [...common, ...moves('two_doors', 0, 4, (t) => [3.5 + t, 5 - t]), ev(2, 'two_doors', 'zone_enter', { zone: 'door_right' }), ev(3, 'two_doors', 'zone_exit', { zone: 'door_right' }), ev(3.5, 'two_doors', 'zone_enter', { zone: 'door_right' }), ev(4, 'two_doors', 'choice', { prompt: 'door', chosen: 'right' })], { params, baseline: base, all: [] });
    expect(bad.metrics.compliance).toBe(0);
    expect(bad.metrics.compliance_latency).toBeCloseTo(-1.5);
    expect(bad.metrics.early_action!).toBeGreaterThan(0.6);
    expect(bad.metrics.forbidden_approaches).toBe(2);
    expect(bad.notes.join(' ')).toMatch(/before the instruction had even finished/);
  });

  it('lift: presses, burst rate, time to pivot, self-rescue', () => {
    const params = { callProp: 't_call', timeout: 90 };
    const presses = [2, 2.4, 2.8, 3.1, 3.5, 3.9, 10].map((t) => ev(t, 'lift', 'interact', { action: 'press', object: 't_call' }));
    const m = scoreTask('lift', [ev(0, 'lift', 'task_start'), ...presses, ev(32, 'lift', 'zone_enter', { zone: 'stairs' }), ev(34, 'lift', 'task_end')], { params, baseline: base, all: [] }).metrics;
    expect(m.button_presses).toBe(7);
    expect(m.peak_press_rate).toBeCloseTo(6 / 5 / 1);
    expect(m.time_to_pivot).toBe(30);
    expect(m.self_rescue).toBe(1);
    const waited = scoreTask('lift', [ev(0, 'lift', 'task_start'), presses[0]!, ev(90, 'lift', 'narrator_start', { line: 'hint' }), ev(95, 'lift', 'zone_enter', { zone: 'stairs' })], { params, baseline: base, all: [] }).metrics;
    expect(waited.self_rescue).toBe(0);
  });

  it('desk: breadth, extra time, path ratio, reading depth and follow-through', () => {
    const params = { itemProps: 't_sticky,t_email,t_mug', shortest: 10, words_t_sticky: 20, words_t_email: 40 };
    const events = [
      ev(0, 'desk', 'task_start'),
      ...moves('desk', 0, 20, (t) => (t < 10 ? [2.5, 13 - t] : [2.5, 3 - (t - 10) * 0.3])),
      ev(4, 'desk', 'interact', { action: 'inspect', object: 't_sticky' }),
      ev(10, 'desk', 'interact', { action: 'inspect_close', object: 't_sticky', seconds: 6 }),
      ev(11, 'desk', 'interact', { action: 'inspect', object: 't_email' }),
      ev(17, 'desk', 'interact', { action: 'inspect_close', object: 't_email', seconds: 6 }),
      ev(20, 'desk', 'task_end'),
    ];
    const later = [ev(60, 'meeting', 'choice', { prompt: 'door', chosen: 'secret', secretOffered: true })];
    const m = scoreTask('desk', events, { params, baseline: base, all: [...events, ...later] }).metrics;
    expect(m.items_inspected).toBeCloseTo(2 / 3);
    expect(m.extra_time).toBeCloseTo(20 - 10 / 1.5);
    expect(m.path_ratio).toBeCloseTo(13 / 10, 1);
    expect(m.reading_depth).toBeCloseTo(12 / (60 / 200 * 60), 2);
    expect(m.follow_through).toBe(1);
    const skipped = scoreTask('desk', [ev(0, 'desk', 'task_start'), ev(9, 'desk', 'task_end')], { params, baseline: base, all: [] }).metrics;
    expect(skipped.items_inspected).toBe(0);
    expect(skipped.follow_through).toBeNull();
  });

  it('meeting: helped, abandoned midway, came back', () => {
    const params = { countdown: 45 };
    const ask = ev(8, 'meeting', 'prompt_shown', { prompt: 'help' });
    const helped = scoreTask('meeting', [ev(0, 'meeting', 'task_start'), ask, ev(12, 'meeting', 'zone_enter', { zone: 'far_end' }), ev(18, 'meeting', 'interact', { action: 'hold_start' }), ev(23, 'meeting', 'interact', { action: 'hold_end', completed: true })], { params, baseline: base, all: [] }).metrics;
    expect(helped).toMatchObject({ helped: 1, help_under_pressure: 1, abandoned_midway: 0, came_back: 1, clock_at_help: 27 });
    const quit = scoreTask('meeting', [ev(0, 'meeting', 'task_start'), ask, ev(9, 'meeting', 'interact', { action: 'hold_start' }), ev(11, 'meeting', 'interact', { action: 'hold_end', completed: false })], { params, baseline: base, all: [] }).metrics;
    expect(quit).toMatchObject({ helped: 0, abandoned_midway: 1, came_back: 0 });
  });

  it('smoke: reaction latency from the smoke, alarm, kept on task, social check', () => {
    const crowd = { condition: 'crowd' };
    const m = scoreTask('smoke', [ev(0, 'smoke', 'task_start'), ev(5, 'smoke', 'interact', { action: 'pickup' }), ev(10, 'smoke', 'smoke_start'), ev(16, 'smoke', 'interact', { action: 'talk' }), ev(20, 'smoke', 'interact', { action: 'alarm' })], { params: crowd, baseline: base, all: [] }).metrics;
    expect(m).toMatchObject({ reaction_latency: 6, raised_alarm: 1, kept_on_task: 1, social_check: 1, crowd: 1 });
    const alone = scoreTask('smoke', [ev(0, 'smoke', 'task_start'), ev(10, 'smoke', 'smoke_start'), ev(13, 'smoke', 'zone_enter', { zone: 'vent' }), ev(30, 'smoke', 'choice', { prompt: 'door' })], { params: { condition: 'alone' }, baseline: base, all: [] }).metrics;
    expect(alone).toMatchObject({ reaction_latency: 3, raised_alarm: 0, kept_on_task: 0, social_check: null, crowd: 0 });
  });
});

// ---------- scripted bots playing whole runs ----------

interface Bot {
  name: string;
  complies: boolean;
  liftPresses: number;
  waitsForLift: boolean;
  curious: boolean;
  helps: boolean;
  pullsAlarm: boolean;
}

const BOTS: Record<string, Bot> = {
  cautious: { name: 'cautious', complies: true, liftPresses: 1, waitsForLift: true, curious: false, helps: true, pullsAlarm: true },
  risky: { name: 'risky', complies: false, liftPresses: 12, waitsForLift: false, curious: false, helps: false, pullsAlarm: false },
  curious: { name: 'curious', complies: true, liftPresses: 2, waitsForLift: false, curious: true, helps: true, pullsAlarm: false },
};

/** Drives a Run the way the adapter would: 10 Hz position samples, prompts, presses, and narrator timing. */
async function play(seed: number, bot: Bot) {
  const said: { text: string; lineId?: string }[] = [];
  const effects: RuleEffect[] = [];
  const run = new Run(seed, gameData, { observeMs: 0, tasks: true, onSay: (text, lineId) => said.push({ text, lineId }), onEffect: (e) => effects.push(e) });
  let t = 0, x = 0, z = 0, shown = 0;
  let room = run.start();
  const send = (e: GameEvent) => {
    run.record(e);
    // Lines appear on screen as soon as they are said.
    while (shown < said.length) {
      const l = said[shown++]!;
      if (l.lineId) run.record({ type: 'narrator_shown', lineId: l.lineId, t });
    }
  };
  const step = () => send({ type: 'move', roomId: room.id, x, z, t: (t = Math.round((t + 0.1) * 1000) / 1000) });
  const wait = (s: number) => { for (let i = 0; i < s * 10; i++) step(); };
  const walk = (tx: number, tz: number, speed = 1.6) => {
    const n = Math.max(1, Math.ceil(Math.hypot(tx - x, tz - z) / (speed * 0.1)));
    const sx = x, sz = z;
    for (let i = 1; i <= n; i++) { x = sx + ((tx - sx) * i) / n; z = sz + ((tz - sz) * i) / n; step(); }
  };
  const doorSpot = (d: Door): [number, number] => {
    const dir = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[d.side];
    return [d.cx + 0.5 + dir[0]! * 0.3, d.cz + 0.5 + dir[1]! * 0.3];
  };
  const prop = (id: string) => room.props.find((p) => p.id === id)!;
  const press = (id: string) => {
    send({ type: 'prompt', roomId: room.id, objectId: id, t });
    wait(0.4);
    send({ type: 'input', roomId: room.id, key: 'KeyE', target: id, t });
    send({ type: 'pressed', roomId: room.id, objectId: id, t });
  };
  const leave = async (doorId: string) => {
    const d = room.layout.doors.find((x) => x.id === doorId)!;
    walk(...doorSpot(d));
    send({ type: 'door_chosen', roomId: room.id, doorId, t });
    room = await run.next(doorId);
    x = room.layout.spawn.x; z = room.layout.spawn.z;
    send({ type: 'room_entered', roomId: room.id, t });
  };

  // Room 0, the baseline: wander, press the button, leave.
  x = room.layout.spawn.x; z = room.layout.spawn.z;
  send({ type: 'room_entered', roomId: room.id, t });
  wait(1);
  for (const [dx, dz] of [[1, -2], [-2, -1], [1, 1]]) {
    send({ type: 'input', roomId: room.id, key: 'KeyW', t });
    walk(x + dx!, z + dz!);
  }
  const button = room.props.find((p) => p.recipe === 'button_pedestal')!;
  walk(button.x, button.z + 1);
  press(button.id);
  await leave('d1');

  // 1. Two doors.
  const p1 = room.task!.params;
  expect(room.task!.id).toBe('two_doors');
  if (bot.complies) { wait(6); await leave(String(p1.allowedDoor)); }
  else await leave(String(p1.forbiddenDoor));

  // 2. Lift.
  const p2 = room.task!.params;
  expect(room.task!.id).toBe('lift');
  walk(prop('t_call').x, prop('t_call').z + 0.8);
  for (let i = 0; i < bot.liftPresses; i++) { press('t_call'); wait(0.05); }
  wait(bot.waitsForLift ? 95 : 6);
  await leave(String(p2.stairsDoor));

  // 3. Desk.
  const p3 = room.task!.params;
  expect(room.task!.id).toBe('desk');
  if (bot.curious) {
    for (const id of String(p3.itemProps).split(',')) {
      const it = prop(id);
      walk(it.x + (room.layout.width / 2 - it.x) * 0.3, it.z + (room.layout.depth / 2 - it.z) * 0.05);
      send({ type: 'prompt', roomId: room.id, objectId: id, t });
      wait(0.3);
      send({ type: 'inspected', roomId: room.id, objectId: id, t });
      wait(5);
      send({ type: 'inspect_closed', roomId: room.id, objectId: id, seconds: 5, t });
    }
  }
  await leave(String(p3.exitDoor));

  // 4. The meeting.
  const p4 = room.task!.params;
  expect(room.task!.id).toBe('meeting');
  expect(effects.some((e) => e.kind === 'timer' && e.seconds === 13)).toBe(true);
  const printer = prop('t_printer');
  walk(printer.x + (room.layout.width / 2 - printer.x) * 0.5, printer.z + (room.layout.depth / 2 - printer.z) * 0.1);
  if (bot.helps) {
    send({ type: 'hold_start', roomId: room.id, objectId: 't_printer', t });
    wait(5);
    send({ type: 'hold_end', roomId: room.id, objectId: 't_printer', seconds: 5, completed: true, t });
  }
  await leave(String(bot.curious ? p4.secretDoor : p4.boardDoor));

  // 5. Smoke.
  const p5 = room.task!.params;
  expect(room.task!.id).toBe('smoke');
  if (bot.pullsAlarm) {
    wait(12);
    const alarm = prop('t_alarm');
    walk(alarm.x + (room.layout.width / 2 - alarm.x) * 0.2, alarm.z + (room.layout.depth / 2 - alarm.z) * 0.2);
    press('t_alarm');
  } else {
    const file = prop('t_file');
    walk(file.x + (room.layout.width / 2 - file.x) * 0.15, file.z + (room.layout.depth / 2 - file.z) * 0.15);
    press('t_file');
    wait(14);
  }
  await leave(String(p5.fireExitDoor));
  return { run, said, effects };
}

const metric = (run: Run, task: TaskId, key: string) => run.finalTaskResults().find((r) => r.task === task)?.metrics[key];

describe('scripted bots play the office', () => {
  it('every metric moves the expected way for each bot', async () => {
    const cautious = (await play(101, BOTS.cautious!)).run;
    const risky = (await play(102, BOTS.risky!)).run;
    const curious = (await play(103, BOTS.curious!)).run;
    for (const r of [cautious, risky, curious]) expect(r.taskResults.map((x) => x.task)).toEqual(OFFICE_TASKS);

    expect(metric(cautious, 'two_doors', 'compliance')).toBe(1);
    expect(metric(risky, 'two_doors', 'compliance')).toBe(0);
    expect(metric(risky, 'two_doors', 'early_action')!).toBeGreaterThan(metric(cautious, 'two_doors', 'early_action')!);

    expect(metric(risky, 'lift', 'button_presses')).toBe(12);
    expect(metric(risky, 'lift', 'peak_press_rate')!).toBeGreaterThan(metric(cautious, 'lift', 'peak_press_rate') ?? 0);
    expect(metric(cautious, 'lift', 'self_rescue')).toBe(0);
    expect(metric(risky, 'lift', 'self_rescue')).toBe(1);

    expect(metric(curious, 'desk', 'items_inspected')).toBe(1);
    expect(metric(risky, 'desk', 'items_inspected')).toBe(0);
    expect(metric(curious, 'desk', 'extra_time')!).toBeGreaterThan(metric(risky, 'desk', 'extra_time')!);
    expect(metric(curious, 'desk', 'reading_depth')!).toBeGreaterThan(0);
    expect(metric(curious, 'desk', 'follow_through')).toBe(1);

    expect(metric(cautious, 'meeting', 'helped')).toBe(1);
    expect(metric(risky, 'meeting', 'helped')).toBe(0);

    expect(metric(cautious, 'smoke', 'raised_alarm')).toBe(1);
    expect(metric(risky, 'smoke', 'raised_alarm')).toBe(0);
    expect(metric(risky, 'smoke', 'kept_on_task')).toBe(1);
    expect(metric(cautious, 'smoke', 'reaction_latency')).not.toBeNull();

    // The tasks feed the hidden profile too.
    expect(cautious.profile.traits.compliance).toBeGreaterThan(risky.profile.traits.compliance);
    expect(curious.profile.traits.curiosity).toBeGreaterThan(risky.profile.traits.curiosity);
  });

  it('the measured lines are fixed, timed, and the scripted moments fire', async () => {
    const { run, said, effects } = await play(104, BOTS.cautious!);
    const side = String(run.rooms[1]!.task!.params.instructedSide);
    expect(said.some((l) => l.text.includes(`Take the ${side} door`))).toBe(true);
    expect(said.some((l) => l.text === gameData.tasks.lift.hint)).toBe(true);
    expect(effects.some((e) => e.kind === 'display' && e.prop === 't_lift')).toBe(true);
    expect(effects.some((e) => e.kind === 'smoke')).toBe(true);
    expect(effects.some((e) => e.kind === 'alarm' && e.on)).toBe(true);
    const log = run.taskLog.events;
    expect(log.some((e) => e.task === 'two_doors' && e.type === 'narrator_start')).toBe(true);
    expect(log.some((e) => e.task === 'two_doors' && e.type === 'narrator_end')).toBe(true);
    // Task rooms speak only through the task: no entry line, no door lines, no rule.
    for (const r of run.rooms.filter((r) => r.task)) {
      expect(r.narrator.onEnter).toBe('');
      expect(r.rule).toBeUndefined();
    }
  });

  it('replaying the log reproduces the metrics exactly', async () => {
    const { run } = await play(105, BOTS.curious!);
    const baseline = computeBaseline(run.taskLog.slice('baseline'));
    const copy = JSON.parse(JSON.stringify(run.taskLog.events)) as TaskEvent[];
    for (const r of run.finalTaskResults()) {
      const again = scoreTask(r.task as TaskId, copy.filter((e) => e.task === r.task), { params: r.params, baseline, all: copy });
      expect(again.metrics, r.task).toEqual(r.metrics);
    }
  });

  it('anomalies and variants share task rooms, without touching the task', async () => {
    const seen = { anomaly: 0, variant: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const run = new Run(seed, gameData, { observeMs: 0, tasks: true });
      let room = run.start();
      for (let i = 1; i <= 5; i++) {
        room = await run.next(room.layout.doors.find((d) => !d.entrance)!.id);
        const where = `seed ${seed} room ${i}`;
        expect(room.task?.id, where).toBe(OFFICE_TASKS[i - 1]);
        expect(room.layout.archetype, where).not.toBe('choice_room');
        if (room.anomaly) {
          seen.anomaly++;
          expect(['blue_door', 'false_exit'], where).not.toContain(room.anomaly.id);
        }
        if (room.variant) seen.variant++;
        // Every task prop is still there, and the task's doors keep their signs.
        for (const f of room.layout.fixtures ?? []) expect(room.props.some((p) => p.id === f.id), `${where} ${f.id}`).toBe(true);
        expect(room.layout.doors.every((d) => !d.concealed), where).toBe(true);
        expect(validateRoom(room, gameData), where).toEqual([]);
      }
    }
    expect(seen.anomaly).toBeGreaterThan(10);
    expect(seen.variant).toBeGreaterThan(0);
  });

  /** A run advanced to the room of `task`, with a tiny driver: walk at walking speed, wait, send events. */
  async function at(task: TaskId, seed = 300) {
    const effects: RuleEffect[] = [];
    const said: { text: string; lineId?: string }[] = [];
    const run = new Run(seed, gameData, { observeMs: 0, tasks: true, onEffect: (e) => effects.push(e), onSay: (text, lineId) => said.push({ text, lineId }) });
    let room = run.start();
    let t = 0;
    run.record({ type: 'room_entered', roomId: room.id, t });
    while (room.task?.id !== task) {
      t += 5;
      run.record({ type: 'door_chosen', roomId: room.id, doorId: room.layout.doors.find((d) => !d.entrance)!.id, t });
      room = await run.next(room.layout.doors.find((d) => !d.entrance)!.id);
      run.record({ type: 'room_entered', roomId: room.id, t });
    }
    let x = room.layout.spawn.x, z = room.layout.spawn.z;
    const step = () => run.record({ type: 'move', roomId: room.id, x, z, t: (t = Math.round((t + 0.1) * 1000) / 1000) });
    const d = {
      run, room, effects, said, get t() { return t; },
      wait(s: number) { for (let i = 0; i < s * 10; i++) step(); },
      walk(tx: number, tz: number, speed = 2.7) {
        const n = Math.max(1, Math.ceil(Math.hypot(tx - x, tz - z) / (speed * 0.1)));
        const sx = x, sz = z;
        for (let i = 1; i <= n; i++) { x = sx + ((tx - sx) * i) / n; z = sz + ((tz - sz) * i) / n; step(); }
      },
      door(id: unknown) { const dd = room.layout.doors.find((x) => x.id === id)!; return [dd.cx + 0.5, dd.cz + 0.5] as const; },
      prop(id: string) { const p = room.props.find((x) => x.id === id)!; return [p.x + Math.sin(p.rotY) * 0.9, p.z + Math.cos(p.rotY) * 0.9] as const; },
      send(e: GameEvent) { run.record(e); },
    };
    return d;
  }

  it('the meeting is a real trade-off: walking straight makes it, stopping to help makes you late', async () => {
    const rush = await at('meeting');
    rush.walk(...rush.door(rush.room.task!.params.boardDoor));
    expect(rush.run.taskLog.events.some((e) => e.task === 'meeting' && e.type === 'countdown_end'), 'straight walk is on time').toBe(false);

    const help = await at('meeting');
    help.walk(...help.prop('t_printer'));
    help.send({ type: 'hold_start', roomId: help.room.id, objectId: 't_printer', t: help.t });
    help.wait(8);
    help.send({ type: 'hold_end', roomId: help.room.id, objectId: 't_printer', seconds: 8, completed: true, t: help.t });
    help.walk(...help.door(help.room.task!.params.boardDoor));
    expect(help.run.taskLog.events.some((e) => e.task === 'meeting' && e.type === 'countdown_end'), 'helping makes you late').toBe(true);
  });

  it('the printer can only be fixed once', async () => {
    const d = await at('meeting');
    d.walk(...d.prop('t_printer'));
    for (let i = 0; i < 2; i++) {
      d.send({ type: 'hold_start', roomId: d.room.id, objectId: 't_printer', t: d.t });
      d.wait(8);
      d.send({ type: 'hold_end', roomId: d.room.id, objectId: 't_printer', seconds: 8, completed: true, t: d.t });
    }
    const log = d.run.taskLog.slice('meeting');
    expect(log.filter((e) => e.type === 'choice' && e.data.chosen === 'help')).toHaveLength(1);
    expect(log.filter((e) => e.data.action === 'hold_start')).toHaveLength(1);
    expect(d.effects.some((e) => e.kind === 'disable' && e.prop === 't_printer')).toBe(true);
  });

  it('smoke: exits stay shut until the smoke starts, which reaching the far desk brings forward', async () => {
    const d = await at('smoke');
    const exits = d.room.layout.doors.filter((x) => !x.entrance).map((x) => x.id);
    expect(d.effects.some((e) => e.kind === 'doors' && exits.every((id) => e.locked.includes(id)))).toBe(true);
    // Before the smoke, the workers make small talk and turn to the player.
    const worker = d.room.task!.params.workerProps ? String(d.room.task!.params.workerProps).split(',')[0] : undefined;
    if (worker) {
      d.send({ type: 'pressed', roomId: d.room.id, objectId: worker, t: d.t });
      expect(gameData.tasks.smoke.workersBefore).toContain(d.said.at(-1)!.text);
      expect(d.effects.some((e) => e.kind === 'glance' && e.at === 'player')).toBe(true);
    }
    d.walk(2, 1.6); // to the far desk, well before the onset time
    const start = d.run.taskLog.slice('smoke').find((e) => e.type === 'smoke_start')!;
    expect(start.data.trigger).toBe('desk');
    expect(start.t - d.run.taskLog.slice('smoke')[0]!.t).toBeLessThan(8);
    expect(d.effects.at(-1)).toEqual({ kind: 'doors', locked: [] });
    if (worker) {
      d.send({ type: 'pressed', roomId: d.room.id, objectId: worker, t: d.t });
      expect(gameData.tasks.smoke.workers).toContain(d.said.at(-1)!.text);
    }
  });

  it('a run without tasks is unchanged: rules, no task rooms', async () => {
    const run = new Run(7, gameData, { observeMs: 0 });
    run.start();
    const room = await run.next('d1');
    expect(room.task).toBeUndefined();
    expect(run.taskLog.events).toHaveLength(0);
  });
});
