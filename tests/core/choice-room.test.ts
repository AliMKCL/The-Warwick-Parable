import { expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { CHOICE_ROOM } from '../../core/room/layouts';
import { validateRoom } from '../../core/room/validate';
import { Run } from '../../core/run/run';

/** Plays a run to the end through the first exit of every room. */
async function play(run: Run) {
  run.start();
  while (!run.finished) await run.next(run.current!.layout.doors.find((d) => !d.entrance)!.id);
  return run;
}

it('is a test room: at most once per run, two marked doors, no rule, no anomaly or variant', async () => {
  let seen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const run = await play(new Run(seed, gameData, { observeMs: 0, waitMs: 100, layout: { tests: 4, fillers: 1, pool: { choice: 3, exit_timer: 1, lights_dim_on_idle: 1 } } }));
    const choices = run.rooms.filter((r) => r.layout.archetype === CHOICE_ROOM);
    expect(choices.length).toBeLessThanOrEqual(1);
    for (const choice of choices) {
      seen++;
      expect(choice.slot).toBe('test');
      expect(choice.test).toBe('choice');
      const exits = choice.layout.doors.filter((door) => !door.entrance);
      expect(exits.map(({ id, label }) => ({ id, label }))).toEqual([{ id: 'd1', label: 'A' }, { id: 'd2', label: 'B' }]);
      expect(exits.every((door) => door.color && !door.concealed)).toBe(true);
      expect(exits[0]!.color).not.toBe(exits[1]!.color);
      expect(choice.rule).toBeUndefined();
      expect(choice.anomaly).toBeUndefined();
      expect(choice.variant).toBeUndefined();
      expect(choice.source).toBe('template');
      expect(validateRoom(choice, gameData)).toEqual([]);
    }
  }
  expect(seen).toBeGreaterThan(20);
});

it('never appears when it is left out of the pool, and ?layout=choice_room puts it next', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const run = await play(new Run(seed, gameData, { observeMs: 0, waitMs: 100, layout: { pool: ['exit_timer', 'lights_dim_on_idle'] } }));
    expect(run.rooms.some((r) => r.layout.archetype === CHOICE_ROOM)).toBe(false);
  }
  const run = new Run(3, gameData, { observeMs: 0, forceArchetypes: [CHOICE_ROOM] });
  run.start();
  expect((await run.next('d1')).layout.archetype).toBe(CHOICE_ROOM);
});
