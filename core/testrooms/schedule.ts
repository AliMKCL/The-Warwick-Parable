import type { Profile } from '../profile/profile';
import { FINALE_HALL, type Archetype } from '../room/layouts';
import type { RoomSpec, SelectionNote } from '../room/types';
import type { TraitName } from '../protocol';
import type { Rng } from '../util/random';
import type { LayoutConfig } from './config';
import { TESTS } from './registry';
import type { TestKind, TestRoomCandidate } from './types';

/** What the room behind a door will be. */
export interface RoomPick {
  slot: 'test' | 'filler' | 'finale';
  test?: TestKind;
  /** A room type, or the name of the test's own room (TestKind.room builds that one). */
  archetype: Archetype | string;
  exits: number;
  /** Why this test was drawn. */
  selection?: SelectionNote;
}

export interface PickContext {
  config: LayoutConfig;
  /** Rooms entered so far, the waiting room first. The last one is the room being left. */
  rooms: RoomSpec[];
  /** Index of the room being planned. */
  index: number;
  /** Index of the finale. */
  last: number;
  /** Extra filler rooms added by lost gambles. */
  detours: number;
  profile: Profile;
  /** Debug (`?layout=`): a room type to use for this room if it fits. */
  forced?: Archetype;
}

/** Tests and fillers still to come, counting from the rooms already entered. */
export function remaining(c: Pick<PickContext, 'config' | 'rooms' | 'detours'>): { tests: number; fillers: number } {
  const done = (slot: string) => c.rooms.filter((r) => r.slot === slot).length;
  return { tests: Math.max(0, c.config.tests - done('test')), fillers: Math.max(0, c.config.fillers + c.detours - done('filler')) };
}

/**
 * Decides the room behind a door as the player reaches it, not in advance: test
 * or filler (drawn in proportion to what's left, so the totals come out exact),
 * which test from the pool (weighted by the config and the player's profile),
 * and which of that test's layouts. Every door of a room is planned separately,
 * so different doors can lead to different kinds of room.
 */
export function pickRoom(c: PickContext, rng: Rng): RoomPick {
  if (c.index >= c.last) return { slot: 'finale', archetype: FINALE_HALL, exits: 1 };
  const left = remaining(c);
  const from = c.rooms.at(-1);
  const fromTest = from?.test ? TESTS[from.test] : undefined;
  const mustTest = !!fromTest?.needsNextTest && from?.slot === 'test' && left.tests > 0;

  // ?layout= asking for a test's own room (the lift lobby, the choice room) makes this room that test.
  const forcedTest = c.forced && left.tests > 0 ? eligible(c, left.tests, from).find((k) => k.candidates.every((x) => x.archetype === c.forced)) : undefined;

  let test = !!forcedTest || mustTest || (left.tests > 0 && (left.fillers === 0 || rng() < left.tests / (left.tests + left.fillers)));
  const drawn = test && !forcedTest ? drawTest(c, left.tests, from, rng) : undefined;
  let kind = test ? forcedTest ?? drawn?.kind : undefined;
  if (test && !kind && left.fillers > 0) test = false; // the pool has nothing that fits here: a filler instead
  if (!test || !kind) return { slot: 'filler', ...filler(c, from, rng) };
  const cand = drawCandidate(kind.candidates, from?.layout.archetype, c.forced, rng);
  return { slot: 'test', test: kind, archetype: cand.archetype, exits: exitCount(cand.exits, c.profile, rng), ...(drawn ? { selection: drawn.note } : {}) };
}

/** Tests from the pool that may go here, strictest first: under their cap, not the previous room's test, room for a follow-up. */
function eligible(c: PickContext, testsLeft: number, from: RoomSpec | undefined, relax = 0): TestKind[] {
  const used = usedCounts(c.rooms);
  return Object.entries(c.config.pool)
    .map(([id, entry]) => ({ kind: TESTS[id]!, entry }))
    .filter(({ kind, entry }) =>
      (relax >= 2 || (used[kind.id] ?? 0) < (entry.max ?? kind.maxPerRun ?? Infinity)) &&
      (relax >= 1 || kind.id !== from?.test) &&
      // A test that needs a test after it can't take the last test slot (relaxed only when nothing else is left).
      (relax >= 3 || !kind.needsNextTest || testsLeft >= 2))
    .map(({ kind }) => kind);
}

function drawTest(c: PickContext, testsLeft: number, from: RoomSpec | undefined, rng: Rng): { kind: TestKind; note: SelectionNote } | undefined {
  for (let relax = 0; relax <= 3; relax++) {
    const kinds = eligible(c, testsLeft, from, relax);
    if (!kinds.length) continue;
    const forced = c.forced ? kinds.filter((k) => k.candidates.some((x) => x.archetype === c.forced)) : [];
    const pool = forced.length ? forced : kinds;
    const scored = scoreTests(pool, c.config.pool, c.profile, c.config.selection, c.config.focus, usedCounts(c.rooms));
    const pick = weighted(scored, (x) => x.score, rng);
    const total = scored.reduce((a, x) => a + x.score, 0);
    const note: SelectionNote = {
      mode: c.config.selection,
      chance: Math.round((pick.score / (total || 1)) * 1000) / 1000,
      others: scored.filter((x) => x !== pick).sort((a, b) => b.bits - a.bits).slice(0, 3).map((x) => ({ test: x.kind.id, bits: round3(x.bits) })),
      ...(c.config.selection === 'adaptive' && pick.best ? { trait: pick.best.trait, bits: round3(pick.bits), sd: round3(c.profile.posterior[pick.best.trait].sd()) } : {}),
    };
    return { kind: pick.kind, note };
  }
  return undefined;
}

export interface ScoredTest {
  kind: TestKind;
  /** Expected information gain over everything the test measures, in bits. */
  bits: number;
  /** The trait it would teach the most about. */
  best?: { trait: TraitName; bits: number };
  /** Relative chance of being drawn. */
  score: number;
}

/**
 * Bayesian adaptive selection. For each test, the expected information gain
 * (mutual information between its outcome and the trait, from the profile's
 * posterior) summed over what it measures. The draw stays random so runs vary,
 * but tilted towards the most informative test:
 *   score = pool weight × (0.1 + bits / best bits) ^ focus
 * `focus` (data/layout.json) trades accuracy for variety: 0 ignores the
 * information (pool weights only), 4 (default) makes the best test about 9×
 * as likely as a half-as-informative one, 8+ nearly always takes the best.
 * `npm run bench` measures both sides. Tests with no `measures` score as the
 * average. 'weighted' keeps the original heuristic weights instead.
 *
 * Exposure control (as in computerised adaptive testing): each earlier use of a
 * test this run multiplies its score by EXPOSURE, so the most informative test
 * doesn't take over the run.
 */
export const EXPOSURE = 0.35;
export function scoreTests(kinds: TestKind[], pool: LayoutConfig['pool'], profile: Profile, selection: LayoutConfig['selection'], focus = 4, used: Record<string, number> = {}): ScoredTest[] {
  const gains = kinds.map((kind) => {
    const per = (kind.measures ?? []).map((m) => ({ trait: m.trait, bits: profile.posterior[m.trait].infoGain(m) }));
    const best = per.reduce<{ trait: TraitName; bits: number } | undefined>((a, x) => (!a || x.bits > a.bits ? x : a), undefined);
    return { kind, bits: per.reduce((a, x) => a + x.bits, 0), best, measured: per.length > 0 };
  });
  const measured = gains.filter((g) => g.measured);
  const avg = measured.length ? measured.reduce((a, g) => a + g.bits, 0) / measured.length : 0;
  for (const g of gains) if (!g.measured) g.bits = avg;
  const top = Math.max(0, ...gains.map((g) => g.bits));
  return gains.map(({ kind, bits, best }) => ({
    kind,
    bits,
    best,
    score: (pool[kind.id]?.weight ?? 1) * (selection === 'weighted' ? kind.weight?.(profile.traits) ?? 1 : (top > 0 ? (0.1 + bits / top) ** focus : 1) * EXPOSURE ** (used[kind.id] ?? 0)),
  }));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

function drawCandidate(cands: TestRoomCandidate[], previous: string | undefined, forced: Archetype | undefined, rng: Rng): TestRoomCandidate {
  const asForced = forced ? cands.filter((x) => x.archetype === forced) : [];
  if (asForced.length) return asForced[0]!;
  const fresh = cands.filter((x) => x.archetype !== previous);
  return weighted(fresh.length ? fresh : cands, (x) => x.weight ?? 1, rng);
}

/** Filler rooms: the layouts in data/layout.json, nudged by the profile (hesitant players get corridors and hubs…). */
function filler(c: PickContext, from: RoomSpec | undefined, rng: Rng): { archetype: Archetype; exits: number } {
  const t = c.profile.traits;
  const w: Partial<Record<Archetype, number>> = { ...c.config.fillerLayouts };
  const bump = (a: Archetype, by: number) => { if (w[a]) w[a]! += by; };
  if (t.hesitation > 0.6) { bump('corridor', 1.5); bump('hub', 1); }
  if (t.curiosity > 0.6) { bump('open_office', 1.5); bump('hub', 0.5); bump('l_gallery', 0.3); bump('u_gallery', 0.3); }
  if (t.impulsivity > 0.6) { bump('corridor', 1); bump('waiting_room', 0.5); }
  let options = (Object.keys(w) as Archetype[]).filter((a) => (w[a] ?? 0) > 0 && a !== from?.layout.archetype);
  if (!options.length) options = (Object.keys(w) as Archetype[]).filter((a) => (w[a] ?? 0) > 0);
  if (!options.length) options = ['waiting_room'];
  const archetype = c.forced && w[c.forced] !== undefined ? c.forced : weighted(options, (a) => w[a] ?? 1, rng);
  return { archetype, exits: exitCount([1, 3], c.profile, rng) };
}

/** Within a range, hesitant players get the most doors, impulsive ones the fewest. */
function exitCount(exits: TestRoomCandidate['exits'], profile: Profile, rng: Rng): number {
  if (typeof exits === 'number') return exits;
  const [lo, hi] = exits ?? [1, 3];
  const t = profile.traits;
  const n = lo + Math.floor(rng() * (hi - lo + 1));
  if (t.hesitation > 0.62) return hi;
  if (t.impulsivity > 0.62) return Math.min(n, Math.max(lo, 2));
  return n;
}

export function usedCounts(rooms: RoomSpec[]): Record<string, number> {
  const used: Record<string, number> = {};
  for (const r of rooms) if (r.test) used[r.test] = (used[r.test] ?? 0) + 1;
  return used;
}

function weighted<T>(items: T[], weight: (x: T) => number, rng: Rng): T {
  const total = items.reduce((a, x) => a + Math.max(0, weight(x)), 0);
  let r = rng() * total;
  for (const x of items) if ((r -= Math.max(0, weight(x))) <= 0) return x;
  return items.at(-1)!;
}
