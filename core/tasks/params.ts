import { createRng, deriveSeed } from '../util/random';

/**
 * The five office tasks (build spec "Office tasks (1 to 5)"), in the order
 * the player meets them: room 1 is the Two Doors, room 5 the Smoky Corridor.
 * The NPC-heavy ones come last, so a shorter run (?rooms=5) cuts them first.
 */
export const OFFICE_TASKS = ['two_doors', 'lift', 'desk', 'meeting', 'smoke'] as const;
export type TaskId = (typeof OFFICE_TASKS)[number];

export type TaskParams = Record<string, number | string | boolean>;

/**
 * The task staged in room `index`, if any. Room 0 is the baseline room and the last room ends the run.
 * `order` is which tasks fill rooms 1, 2, 3...: tasks 1 to 5 by default; any of the office modules
 * (6 to 11, see core/tasks/office) can be listed too.
 */
export function taskFor<T extends string = TaskId>(index: number, last: number, order: readonly T[] = OFFICE_TASKS as unknown as T[]): T | undefined {
  if (index < 1 || index >= last) return undefined;
  return order[index - 1];
}

/**
 * Per-session tunables. Only the two between-player conditions from the spec
 * are randomised (which door is instructed, crowd or alone in the smoke);
 * the rest sit at the spec's defaults so every player gets the same test.
 * A level generator can change them later.
 */
export function sessionParams(seed: number): Record<TaskId, TaskParams> {
  const rng = createRng(deriveSeed(seed, 'office-tasks'));
  return {
    two_doors: { instructedSide: rng() < 0.5 ? 'left' : 'right', lineVariant: rng() < 0.5 ? 0 : 1 },
    lift: { timeout: 90, stairs: 'plain' },
    desk: { items: 5, offset: 'near' },
    // Tight on purpose: walking straight to the boardroom takes about 6 s, so 13 s is enough on its own,
    // but stopping for the 8 s printer fix (plus the walk to it) makes the player late. Helping costs something.
    meeting: { countdown: 13, helpSeconds: 8 },
    // Smoke starts at `onset` s or as soon as the player reaches the far desk, whichever comes first;
    // the exits stay shut until then, so nobody can leave before it starts.
    smoke: { condition: rng() < 0.5 ? 'crowd' : 'alone', workers: 3, onset: 8, growth: 60 },
  };
}
