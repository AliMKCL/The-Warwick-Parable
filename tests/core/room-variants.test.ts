import { expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { validateRoom } from '../../core/room/validate';
import { Run } from '../../core/run/run';

it('seeds distinct room variants, keeps them rare, and preserves playable layouts', async () => {
  const counts = { messy: 0, ceiling: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const run = new Run(seed, gameData, { observeMs: 0, waitMs: 100 });
    let room = run.start();
    expect(room.variant).toBeUndefined();
    const seen = new Set<string>();
    while (!run.finished) {
      const door = room.layout.doors.find((door) => !door.entrance)!;
      const previous = room;
      room = await run.next(door.id);
      if (!room.variant) continue;

      expect(previous.variant).toBeUndefined();
      expect(seen.has(room.variant)).toBe(false);
      expect(room.anomaly).toBeUndefined();
      expect(validateRoom(room, gameData)).toEqual([]);
      expect(room.narrator.onEnter).toMatch(room.variant === 'ceiling' ? /gravity/i : /order/i);
      counts[room.variant]++;
      seen.add(room.variant);
    }
    expect(room.variant).toBeUndefined();
  }
  for (const count of Object.values(counts)) {
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(40);
  }
});
