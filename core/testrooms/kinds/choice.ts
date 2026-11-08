import { CHOICE_ROOM } from '../../room/layouts';
import type { TestKind } from '../types';

/**
 * Kaan's choice room: two marked doors, blue A and orange B. No rule runs; the
 * door the player takes (reported by `door_chosen`) is the test.
 */
export const choice: TestKind = {
  id: 'choice',
  candidates: [{ archetype: CHOICE_ROOM }],
  maxPerRun: 1,
  setPiece: true,
  modelWritten: false,
  params: () => null,
  describe: () => '',
};
