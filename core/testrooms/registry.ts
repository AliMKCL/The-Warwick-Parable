import type { TestKind } from './types';
import { choice } from './kinds/choice';
import { countdown } from './kinds/countdown';
import { gamble } from './kinds/gamble';
import { lift } from './kinds/lift';
import { lights } from './kinds/lights';
import { suggest } from './kinds/suggest';
import { unlock } from './kinds/unlock';

/**
 * Every test a room can hold. To add one: write `kinds/<name>.ts` exporting a
 * TestKind, add it to this list, give it lines in data/templates.json
 * (`rules.<id>`: line, done, optional tried) and a weight in data/layout.json.
 */
export const TEST_KINDS: TestKind[] = [lights, unlock, countdown, suggest, gamble, lift, choice];

export const TESTS: Record<string, TestKind> = Object.fromEntries(TEST_KINDS.map((k) => [k.id, k]));
