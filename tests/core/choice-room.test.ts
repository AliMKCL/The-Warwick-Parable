import { expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { CoreMessage } from '../../core/protocol';
import { CHOICE_ROOM } from '../../core/room/layouts';
import { validateRoom } from '../../core/room/validate';
import { createCore } from '../../core/run/core';
import { Run } from '../../core/run/run';

it('visits one choice room per seed, on either route and at every eligible position', async () => {
  const positions = new Set<number>();
  for (let seed = 1; seed <= 32; seed++) {
    for (const runLength of [3, 7]) {
      const positionsByRoute: number[] = [];
      for (const branch of ['first', 'last']) {
        const run = new Run(seed, gameData, { runLength, observeMs: 0, waitMs: 100 });
        let room = run.start();
        expect(room.layout.archetype).not.toBe(CHOICE_ROOM);
        while (!run.finished) {
          const exits = room.layout.doors.filter((door) => !door.entrance);
          const door = branch === 'first' ? exits[0]! : exits.at(-1)!;
          room = await run.next(door.id);
        }
        const choices = run.rooms.filter((entry) => entry.layout.archetype === CHOICE_ROOM);
        expect(choices).toHaveLength(1);
        const choice = choices[0]!;
        const exits = choice.layout.doors.filter((door) => !door.entrance);
        expect(exits.map(({ id, label }) => ({ id, label }))).toEqual([
          { id: 'd1', label: 'A' }, { id: 'd2', label: 'B' },
        ]);
        expect(exits.every((door) => door.color && !door.concealed)).toBe(true);
        expect(exits[0]!.color).not.toBe(exits[1]!.color);
        expect(choice.rule).toBeUndefined();
        expect(choice.anomaly).toBeUndefined();
        expect(choice.variant).toBeUndefined();
        expect(validateRoom(choice, gameData)).toEqual([]);
        positionsByRoute.push(choice.index);
        if (runLength === 7) positions.add(choice.index);
      }
      expect(positionsByRoute[0]).toBe(positionsByRoute[1]);
    }
  }
  expect([...positions].sort()).toEqual([1, 2, 3, 4, 5, 6]);
});

it.each(['d1', 'd2'])('ends the run when the last room is the Choice Room and the player uses %s', async (doorId) => {
  const core = createCore(gameData, { runLength: 3, observeMs: 0 });
  const ended = new Promise<CoreMessage>((resolve) => core.onMessage((message) => {
    if (message.type === 'run_ended') resolve(message);
  }));
  core.send({ type: 'run_started', seed: 4, t: 0 });
  const run = core.run()!;
  while (!run.finished) {
    await run.next(run.current!.layout.doors.find((door) => !door.entrance)!.id);
  }
  expect(run.current!.layout.archetype).toBe(CHOICE_ROOM);
  core.send({ type: 'door_chosen', roomId: run.current!.id, doorId, t: 15 });
  expect((await ended).type).toBe('run_ended');
  expect(run.events.at(-1)).toMatchObject({ type: 'door_chosen', doorId });
});
