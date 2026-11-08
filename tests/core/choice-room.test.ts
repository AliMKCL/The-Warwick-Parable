import { expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { CHOICE_ROOM } from '../../core/room/layouts';
import { validateRoom } from '../../core/room/validate';
import { choiceRoomFor, gamblePlan, Run } from '../../core/run/run';

it('visits one choice room per seed where one fits, on either route and at every eligible position', async () => {
  for (const runLength of [3, 7, 10]) {
    const gambles = gamblePlan(runLength - 1);
    const eligible = Array.from({ length: runLength - 2 }, (_, i) => i + 1).filter((i) => !gambles.has(i) && !gambles.has(i - 1));
    const positions = new Set<number>();
    for (let seed = 1; seed <= 32; seed++) {
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
        expect(choices).toHaveLength(eligible.length ? 1 : 0);
        const choice = choices[0];
        if (!choice) continue;
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
        positions.add(choice.index);
      }
      if (positionsByRoute.length) expect(positionsByRoute[0]).toBe(positionsByRoute[1]);
    }
    // Never a gamble room, the room behind one, or the final room; every other room gets it at some seed.
    expect([...positions].sort((a, b) => a - b), `runLength ${runLength}`).toEqual(eligible);
    for (let seed = 1; seed <= 200; seed++) expect(choiceRoomFor(seed, runLength - 1, gambles)).toEqual(eligible.length ? expect.any(Number) : -1);
  }
});

it('never makes the final room the choice room, so the finale keeps its single way on', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const run = new Run(seed, gameData, { observeMs: 0, waitMs: 100 });
    run.start();
    while (!run.finished) await run.next(run.current!.layout.doors.find((door) => !door.entrance)!.id);
    expect(run.current!.layout.archetype).not.toBe(CHOICE_ROOM);
    expect(run.current!.layout.doors.filter((door) => !door.entrance)).toHaveLength(1);
  }
});
