import { afterEach, expect, it, vi } from 'vitest';
import { Run } from '../../core/run/run';
import { gameData } from '../../core/data';
import { ANOMALIES } from '../../core/anomalies/catalog';
import { AnomalyRuntime } from '../../core/anomalies/anomalies';
import { validateRoom } from '../../core/room/validate';
import { RuleRuntime } from '../../core/rules/rules';
import { Profile } from '../../core/profile/profile';
import { createRng } from '../../core/util/random';
import { fakeLlm } from './fakeLlm';
import type { AnomalyEffect, GameEvent, RuleEffect } from '../../core/protocol';

async function walk(
  seed: number,
  maxAnomalies = 6,
  length = 32,
  llm?: ReturnType<typeof fakeLlm>,
) {
  const run = new Run(seed, gameData, {
    observeMs: 0,
    maxAnomalies,
    runLength: length,
    llm,
  });
  run.start();
  while (!run.finished) {
    const room = run.current!;
    const door = room.layout.doors.find((d) => !d.entrance)!;
    run.record({
      type: 'door_chosen',
      roomId: room.id,
      doorId: door.id,
      t: room.index * 10,
    });
    await run.next(door.id);
  }
  return run;
}
afterEach(() => vi.useRealTimers());

it('enforces configurable caps, spacing, uniqueness and playable geometry across seeds', async () => {
  const seen = new Set<string>();
  const counts = new Set<number>();
  for (let seed = 1; seed <= 60; seed++) {
    const run = await walk(seed);
    const encounters = run.rooms.filter((r) => r.anomaly);
    counts.add(encounters.length);
    expect(encounters.length).toBeLessThanOrEqual(6);
    expect(new Set(encounters.map((r) => r.anomaly!.id)).size).toBe(
      encounters.length,
    );
    for (const r of run.rooms) {
      expect(
        validateRoom(r, gameData),
        `seed ${seed}, room ${r.index}`,
      ).toEqual([]);
      if (!r.anomaly) continue;
      seen.add(r.anomaly.id);
      expect(r.index).toBeGreaterThan(0);
      expect(r.index).toBeLessThan(run.last);
      expect(run.rooms[r.index - 1]!.anomaly).toBeUndefined();
      if (r.anomaly.id === 'borrowed_clock')
        expect(r.rule?.id).toBe('exit_timer');
      if (r.anomaly.id === 'false_exit')
        expect(
          r.layout.doors.filter((d) => !d.entrance && !d.concealed).length,
        ).toBeGreaterThan(0);
    }
  }
  expect(seen.size).toBe(ANOMALIES.length);
  expect([...counts]).toContain(6);
  for (const cap of [0, 1, 2, -1, NaN]) {
    const run = await walk(25, cap);
    expect(run.rooms.filter((r) => r.anomaly).length).toBeLessThanOrEqual(
      Number.isFinite(cap) ? Math.max(0, cap) : 0,
    );
  }
});

it('replays the same encounters and varies short-run counts between seeds', async () => {
  const a = await walk(81),
    b = await walk(81);
  expect(a.rooms.map((r) => r.anomaly)).toEqual(b.rooms.map((r) => r.anomaly));
  const counts = new Set<number>();
  for (let seed = 1; seed <= 20; seed++)
    counts.add((await walk(seed, 6, 7)).rooms.filter((r) => r.anomaly).length);
  expect(counts.size).toBeGreaterThan(1);
});

it('keeps caps and placement valid in model-generated and failed-model rooms', async () => {
  for (const mode of ['good', 'down'] as const) {
    const run = await walk(18, 2, 20, fakeLlm({ mode }));
    expect(run.rooms.filter((r) => r.anomaly).length).toBeLessThanOrEqual(2);
    for (const r of run.rooms) expect(validateRoom(r, gameData)).toEqual([]);
  }
});

it('handles every encounter, rejects stale events, and speaks once for completed stages', async () => {
  const base = new Run(8, gameData).start();
  for (const def of ANOMALIES) {
    const room = structuredClone(base);
    room.anomaly = {
      id: def.id,
      anchor: room.props[0]!,
      doorId: 'd1',
      record: 'You pressed the button.',
    };
    const effects: AnomalyEffect[] = [],
      lines: string[] = [];
    const events: GameEvent[] = [];
    const runtime = new AnomalyRuntime(
      room,
      events,
      (e) => effects.push(e),
      (s) => lines.push(s),
      () => true,
    );
    const use: GameEvent = {
      type: 'anomaly_action',
      roomId: room.id,
      anomalyId: def.id,
      action: 'use',
      t: 5,
    };
    runtime.onEvent({ ...use, roomId: 'stale' });
    expect(effects).toHaveLength(0);
    runtime.onEvent(use);
    runtime.onEvent(use);
    const count = lines.length;
    runtime.onEvent(use);
    expect(lines).toHaveLength(count);
    expect(effects.length).toBeGreaterThan(0);
  }
});

it('extends a running countdown exactly once and expires at the new deadline', () => {
  vi.useFakeTimers();
  const room = new Run(2, gameData).start();
  const effects: RuleEffect[] = [];
  const rule = new RuleRuntime(
    { id: 'exit_timer', params: { seconds: 30 }, line: '', doneLine: '' },
    {
      room,
      data: gameData,
      profile: new Profile(gameData),
      rng: createRng(1),
      emit: (e) => effects.push(e),
      say: () => {},
    },
  );
  expect(rule.borrowTime(0, 8)).toBe(false);
  rule.start(0);
  vi.advanceTimersByTime(5000);
  expect(rule.borrowTime(5, 8)).toBe(true);
  expect(rule.borrowTime(5, 8)).toBe(false);
  expect(effects.at(-1)).toEqual({
    kind: 'timer',
    seconds: 33,
    label: 'Doors close in',
  });
  vi.advanceTimersByTime(25000);
  expect(effects.some((e) => e.kind === 'doors')).toBe(false);
  vi.advanceTimersByTime(8000);
  expect(effects.at(-1)?.kind).toBe('doors');
  expect(rule.borrowTime(38, 8)).toBe(false);
  rule.stop();
});

it('counts an anomaly inspection before a lock rule starts without counting repeat actions twice', () => {
  const room = new Run(2, gameData).start();
  room.anomaly = {
    id: 'ceiling_cabinet',
    anchor: room.props[0]!,
    doorId: 'd1',
    record: '',
  };
  const effects: RuleEffect[] = [];
  const rule = new RuleRuntime(
    { id: 'inspect_to_unlock', params: { count: 2 }, line: '', doneLine: '' },
    {
      room,
      data: gameData,
      profile: new Profile(gameData),
      rng: createRng(1),
      emit: (e) => effects.push(e),
      say: () => {},
    },
  );
  const action: GameEvent = {
    type: 'anomaly_action',
    roomId: room.id,
    anomalyId: 'ceiling_cabinet',
    action: 'use',
    t: 1,
  };
  rule.start(2, [action]);
  rule.onEvent(action);
  expect(effects.at(-1)?.kind).toBe('doors');
  expect(effects.at(-1)).not.toEqual({ kind: 'doors', locked: [] });
  rule.onEvent({
    type: 'inspected',
    roomId: room.id,
    objectId: room.props[0]!.id,
    t: 3,
  });
  expect(effects.at(-1)).toEqual({ kind: 'doors', locked: [] });
  rule.stop();
});
