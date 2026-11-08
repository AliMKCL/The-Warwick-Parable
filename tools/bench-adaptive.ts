/**
 * Benchmarks for the distance fields + path analysis (option 5) and the
 * Bayesian adaptive test selection (option 1).
 *
 *   npm run bench                 all of it
 *   npm run bench -- --quick      fewer rooms and simulated players
 *   npm run bench -- --json f     also write the numbers to a file
 *
 * Part A is runtime cost on real generated rooms (furnished from templates).
 * Part B is convergence: simulated players with known trait values go through
 * test rooms drawn by each selection method from the real pool in
 * data/layout.json, with each test's real `measures`, and we see how quickly
 * each method's estimate gets close to the truth.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TRAITS, Profile } from '../core/profile/profile';
import { logistic } from '../core/profile/bayes';
import { PathTracker } from '../core/profile/path';
import { distanceField, roomFields, routeTo } from '../core/room/fields';
import type { RoomSpec } from '../core/room/types';
import { Run } from '../core/run/run';
import { resolveLayout, type Selection } from '../core/testrooms/config';
import { pickRoom } from '../core/testrooms/schedule';
import { createRng } from '../core/util/random';
import type { TraitName } from '../core/protocol';
import { loadGameData } from './data-node';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const data = loadGameData();
const out: Record<string, unknown> = {};

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { mean: xs.reduce((a, x) => a + x, 0) / xs.length, p50: q(0.5), p95: q(0.95), max: s.at(-1)! };
};
const us = (ms: number) => `${(ms * 1000).toFixed(ms < 0.01 ? 2 : 1)} µs`;
const FRAME = 1000 / 60;

/** Time `fn` by running it `n` times (after a warm-up), per call in ms. */
function time(fn: () => void, n: number): number {
  for (let i = 0; i < Math.min(200, n); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
}

// ---------------------------------------------------------------------------
// Real rooms: play runs to the end with templates, keep every room entered.
async function collectRooms(n: number): Promise<RoomSpec[]> {
  const rooms: RoomSpec[] = [];
  for (let seed = 1; rooms.length < n; seed++) {
    const run = new Run(seed, data, { observeMs: 0, waitMs: 50, layout: { tests: 5, fillers: 3 } });
    run.start();
    const rng = createRng(seed * 13);
    while (!run.finished) {
      const exits = run.current!.layout.doors.filter((d) => !d.entrance);
      await run.next(exits[Math.floor(rng() * exits.length)]!.id);
    }
    rooms.push(...run.rooms);
    run.depart();
  }
  return rooms.slice(0, n);
}

/** The way it would be done without fields: a fresh shortest-path search from the player's cell on every sample. */
function naiveDistances(spec: RoomSpec, walkable: Uint8Array, x: number, z: number): number[] {
  const { layout } = spec;
  const f = distanceField(layout.width, layout.depth, walkable, [{ cx: Math.floor(x), cz: Math.floor(z), cost: 0 }]);
  return layout.doors.filter((d) => !d.entrance).map((d) => f.d[d.cz * layout.width + d.cx]! + 0.5);
}

async function partA() {
  const N = quick ? 120 : 600;
  const rooms = await collectRooms(N);
  const build: number[] = [];
  const cells: number[] = [];
  const perSample: number[] = [];
  const naivePerSample: number[] = [];
  const archetypes = new Map<string, number[]>();
  for (const spec of rooms) {
    const reps = 50;
    const ms = time(() => roomFields(spec, data), reps);
    build.push(ms);
    cells.push(spec.layout.width * spec.layout.depth);
    archetypes.set(spec.layout.archetype, [...(archetypes.get(spec.layout.archetype) ?? []), ms]);
    const fields = roomFields(spec, data);
    // A realistic walk: spawn to every exit in turn, then out of the first, sampled at 10 Hz.
    const pts: [number, number][] = [];
    let [x, z] = [spec.layout.spawn.x, spec.layout.spawn.z];
    for (const id of Object.keys(fields.exits)) {
      for (const [px, pz] of routeTo(fields.exits[id]!, x, z)) {
        const n = Math.max(1, Math.ceil(Math.hypot(px - x, pz - z) / 0.14));
        for (let i = 1; i <= n; i++) pts.push([x + ((px - x) * i) / n, z + ((pz - z) * i) / n]);
        [x, z] = [px, pz];
      }
    }
    if (pts.length < 2) continue;
    const tracker = new PathTracker(spec, fields, 0);
    let k = 0;
    perSample.push(time(() => { const p = pts[k++ % pts.length]!; tracker.move(p[0], p[1], k / 10); }, Math.max(2000, pts.length * 20)));
    let j = 0;
    naivePerSample.push(time(() => { const p = pts[j++ % pts.length]!; naiveDistances(spec, fields.walkable, p[0], p[1]); }, Math.max(500, pts.length * 4)));
  }
  const b = stats(build), s = stats(perSample), nv = stats(naivePerSample), c = stats(cells);
  console.log(`\n## A. Runtime cost (${rooms.length} real rooms, ${archetypes.size} layouts)\n`);
  console.log('| What | Mean | p95 | Max | Share of a 60 fps frame (mean) |');
  console.log('|---|---|---|---|---|');
  console.log(`| Build distance fields for every exit, once per room | ${us(b.mean)} | ${us(b.p95)} | ${us(b.max)} | ${((b.mean / FRAME) * 100).toFixed(3)}% (once, not per frame) |`);
  console.log(`| Read one 10 Hz position sample (all doors) | ${us(s.mean)} | ${us(s.p95)} | ${us(s.max)} | ${((s.mean / FRAME) * 100).toFixed(4)}% |`);
  console.log(`| Same sample without fields (path search per sample) | ${us(nv.mean)} | ${us(nv.p95)} | ${us(nv.max)} | ${((nv.mean / FRAME) * 100).toFixed(4)}% |`);
  console.log(`\nPrecomputed fields make each sample **${(nv.mean / s.mean).toFixed(0)}× faster** than searching per sample; the fields pay for themselves after ${Math.ceil(b.mean / Math.max(1e-9, nv.mean - s.mean))} samples (${(Math.ceil(b.mean / Math.max(1e-9, nv.mean - s.mean)) / 10).toFixed(1)} s of play). Rooms are ${c.p50} cells at the median (max ${c.max}).`);
  console.log('\nBuild time by layout (mean):', [...archetypes].map(([a, xs]) => `${a} ${us(stats(xs).mean)}`).join(', '));

  // Selection and profile updates.
  const config = resolveLayout(data.layout, { tests: 5, fillers: 0 });
  const profile = new Profile(data);
  for (let i = 0; i < 8; i++) profile.respond(TRAITS[i % 4]!, (i % 3 ? 1 : 0) as 0 | 1, { a: 8, b: 0.5 }, 1, 'bench', 0, i);
  const ctx = (selection: Selection) => ({ config: { ...config, selection }, rooms: [] as RoomSpec[], index: 1, last: 6, detours: 0, profile });
  let r = 0;
  const pickAdaptive = time(() => pickRoom(ctx('adaptive'), createRng(r++)), 5000);
  const pickWeighted = time(() => pickRoom(ctx('weighted'), createRng(r++)), 5000);
  const room = rooms[0]!;
  const p2 = new Profile(data);
  let q = 0;
  const adjust = time(() => p2.adjust(TRAITS[q % 4]!, q++ % 2 ? 0.01 : -0.01, 'bench', { ...room, id: `r${q}` }, q), 20000);
  const old = { v: 0.5 };
  const additive = time(() => { old.v = Math.max(0.02, Math.min(0.98, old.v + 0.01)); }, 200000);
  console.log('\n| What | Per call | Calls per room |');
  console.log('|---|---|---|');
  console.log(`| Pick the room behind a door, adaptive (expected information gain over ${Object.keys(config.pool).length} tests) | ${us(pickAdaptive)} | one per exit (1–3) |`);
  console.log(`| Pick the room behind a door, weighted (old heuristic) | ${us(pickWeighted)} | one per exit |`);
  console.log(`| One profile update, Bayesian posterior (51-point grid) | ${us(adjust)} | ~5–20 |`);
  console.log(`| One profile update, old additive score | ${us(additive)} | ~5–20 |`);
  Object.assign(out, {
    rooms: rooms.length,
    fieldsBuildMs: b, sampleMs: s, naiveSampleMs: nv, sampleSpeedup: nv.mean / s.mean,
    pickAdaptiveMs: pickAdaptive, pickWeightedMs: pickWeighted, bayesAdjustMs: adjust, additiveAdjustMs: additive,
  });
}

// ---------------------------------------------------------------------------
// B. Convergence: how many tests until the profile is right?
type Policy = Selection | 'uniform';
const POLICIES: Policy[] = ['adaptive', 'weighted', 'uniform'];
const MAX_TESTS = 10;
const band = (v: number) => (v >= 0.62 ? 2 : v <= 0.38 ? 0 : 1);

interface Curve { rmse: number[]; sd: number[]; bands: number[]; untested: number[]; variety: Variety }
interface Variety { firstTestShare: number; distinctOpenings: number; distinctSets: number; choiceEntropyBits: number }

/** How varied runs stay: share of runs that open with the most common test, distinct first-3 sequences, distinct 5-test sets, entropy of each pick. */
function variety(orders: string[][], T: number): Variety {
  const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const first = count(orders.map((o) => o[0]!));
  let h = 0;
  for (let i = 0; i < T; i++) {
    const c = count(orders.map((o) => o[i]!));
    for (const v of c.values()) { const p = v / orders.length; h -= (p * Math.log2(p)) / T; }
  }
  return {
    firstTestShare: Math.max(...first.values()) / orders.length,
    distinctOpenings: count(orders.map((o) => o.slice(0, 3).join('>'))).size,
    distinctSets: count(orders.map((o) => [...o.slice(0, T)].sort().join(','))).size,
    choiceEntropyBits: h,
  };
}

/**
 * One simulated player: true trait values drawn uniformly from [0.05, 0.95].
 * Each test room: the scheduler picks a test (from the posterior as it stood
 * when the previous room was entered, as in the game, where the room behind
 * a door is planned on arrival), then the player responds to each of the
 * test's items with P(y=1) = σ(a(θ − b)), and the profile updates.
 */
function simulate(policy: Policy, seed: number, lag: number, focus?: number): { err: number[]; sd: number[]; bands: number[]; untested: number[]; order: string[] } {
  const rng = createRng(seed);
  const truth = Object.fromEntries(TRAITS.map((t) => [t, 0.05 + 0.9 * rng()])) as Record<TraitName, number>;
  const profile = new Profile(data);
  const snapshots: Profile[] = [];
  const config = resolveLayout(data.layout, { tests: MAX_TESTS, fillers: 0, selection: policy === 'uniform' ? 'weighted' : policy, ...(focus !== undefined ? { focus } : {}) });
  const rooms: RoomSpec[] = [];
  const err: number[] = [], sd: number[] = [], bands: number[] = [], untested: number[] = [];
  const touched = new Set<TraitName>();
  for (let i = 0; i < MAX_TESTS; i++) {
    // The posterior the scheduler sees: `lag` rooms behind.
    const seen = lag && snapshots.length >= lag ? snapshots[snapshots.length - lag]! : lag ? new Profile(data) : profile;
    const view = policy === 'uniform' ? withoutHeuristics(seen) : seen;
    const pick = pickRoom({ config, rooms, index: i + 1, last: MAX_TESTS + 1, detours: 0, profile: view }, createRng(seed * 977 + i));
    const kind = pick.test!;
    rooms.push({ slot: 'test', test: kind.id, layout: { archetype: pick.archetype } } as unknown as RoomSpec);
    snapshots.push(clone(profile));
    for (const m of kind.measures ?? []) {
      const y = rng() < logistic(m.a * (truth[m.trait] - m.b)) ? 1 : 0;
      profile.respond(m.trait, y, m, 1, kind.id, i + 1, i);
      touched.add(m.trait);
    }
    err.push(Math.sqrt(TRAITS.reduce((a, t) => a + (profile.traits[t] - truth[t]) ** 2, 0) / TRAITS.length));
    sd.push(TRAITS.reduce((a, t) => a + profile.posterior[t].sd(), 0) / TRAITS.length);
    bands.push(TRAITS.filter((t) => band(profile.traits[t]) === band(truth[t])).length / TRAITS.length);
    untested.push(TRAITS.length - touched.size);
  }
  return { err, sd, bands, untested, order: rooms.map((r) => r.test!) };
}

/** For the 'uniform' baseline: the same pool weights, with every test's profile heuristic switched off. */
function withoutHeuristics(p: Profile): Profile {
  const q = clone(p);
  (q as unknown as { traits: Record<TraitName, number> }).traits = { hesitation: 0.5, curiosity: 0.5, compliance: 0.5, impulsivity: 0.5 };
  return q;
}

function clone(p: Profile): Profile {
  const q = new Profile(data);
  for (const t of TRAITS) Object.assign(q.posterior[t], structuredClone(p.posterior[t]));
  q.traits = { ...p.traits };
  return q;
}

function partB() {
  const N = quick ? 300 : 2000;
  const report = (lag: number) => {
    const curves = {} as Record<Policy, Curve>;
    for (const policy of POLICIES) {
      const runs = Array.from({ length: N }, (_, i) => simulate(policy, 1000 + i, lag));
      const avg = (k: 'err' | 'sd' | 'bands' | 'untested') => Array.from({ length: MAX_TESTS }, (_, n) => runs.reduce((a, r) => a + r[k][n]!, 0) / N);
      curves[policy] = { rmse: avg('err'), sd: avg('sd'), bands: avg('bands'), untested: avg('untested'), variety: variety(runs.map((r) => r.order), Math.min(MAX_TESTS, resolveLayout(data.layout).tests)) };
    }
    return curves;
  };
  for (const lag of [1, 0]) {
    const c = report(lag);
    console.log(`\n## B. Convergence, ${N} simulated players per method${lag ? ' (as in the game: the next test is planned on entering the room before it)' : ' (if the next test were picked after the previous one finished)'}\n`);
    console.log('| Tests done | ' + POLICIES.map((p) => `${p}: error / band right / traits never tested`).join(' | ') + ' |');
    console.log('|---|' + POLICIES.map(() => '---').join('|') + '|');
    for (let n = 0; n < MAX_TESTS; n++)
      console.log(`| ${n + 1} | ` + POLICIES.map((p) => `${c[p].rmse[n]!.toFixed(3)} / ${(c[p].bands[n]! * 100).toFixed(0)}% / ${c[p].untested[n]!.toFixed(2)}`).join(' | ') + ' |');
    // How many tests does adaptive need to match the others at the default run (data/layout.json tests)?
    const T = Math.min(MAX_TESTS, resolveLayout(data.layout).tests);
    for (const other of ['weighted', 'uniform'] as const) {
      const target = c[other].rmse[T - 1]!;
      const n = c.adaptive.rmse.findIndex((e) => e <= target);
      const interp = n <= 0 ? n + 1 : n + (c.adaptive.rmse[n - 1]! - target) / (c.adaptive.rmse[n - 1]! - c.adaptive.rmse[n]!);
      console.log(`\nAdaptive reaches the accuracy ${other} has after ${T} tests (error ${target.toFixed(3)}) after **${n < 0 ? `>${MAX_TESTS}` : interp.toFixed(1)} tests**${n >= 0 ? ` (${(((T - interp) / T) * 100).toFixed(0)}% fewer rooms)` : ''}. At ${T} tests: error ${c.adaptive.rmse[T - 1]!.toFixed(3)} vs ${target.toFixed(3)} (${(((target - c.adaptive.rmse[T - 1]!) / target) * 100).toFixed(0)}% lower), traits in the right band ${(c.adaptive.bands[T - 1]! * 100).toFixed(0)}% vs ${(c[other].bands[T - 1]! * 100).toFixed(0)}%, traits never tested ${c.adaptive.untested[T - 1]!.toFixed(2)} vs ${c[other].untested[T - 1]!.toFixed(2)}.`);
    }
    console.log(`\nVariety over ${N} runs (first ${Math.min(MAX_TESTS, resolveLayout(data.layout).tests)} tests): ` + POLICIES.map((p) => `${p}: most common opening test in ${(c[p].variety.firstTestShare * 100).toFixed(0)}% of runs, ${c[p].variety.distinctOpenings} different first-three sequences, ${c[p].variety.distinctSets} different test sets, ${c[p].variety.choiceEntropyBits.toFixed(2)} bits per pick`).join('; ') + '.');
    out[`convergence_lag${lag}`] = c;
  }
}

/** Accuracy against variety for different `focus` values (adaptive), against the weighted baseline at the default test count. */
function partC() {
  const N = quick ? 300 : 1000;
  const T = Math.min(MAX_TESTS, resolveLayout(data.layout).tests);
  const base = Array.from({ length: N }, (_, i) => simulate('weighted', 5000 + i, 1));
  const baseErr = base.reduce((a, r) => a + r.err[T - 1]!, 0) / N;
  const baseVar = variety(base.map((r) => r.order), T);
  console.log(`\n## C. The focus knob (data/layout.json "focus"), ${N} players each, ${T} tests, against weighted (error ${baseErr.toFixed(3)}, ${baseVar.distinctSets} different test sets)\n`);
  console.log('| focus | Tests to match weighted | Error after ' + T + ' | Traits never tested | Most common opening | Different test sets |');
  console.log('|---|---|---|---|---|---|');
  const rows = [];
  for (const focus of [0, 2, 4, 6, 8, 12]) {
    const runs = Array.from({ length: N }, (_, i) => simulate('adaptive', 5000 + i, 1, focus));
    const err = Array.from({ length: MAX_TESTS }, (_, n) => runs.reduce((a, r) => a + r.err[n]!, 0) / N);
    const n = err.findIndex((e) => e <= baseErr);
    const match = n < 0 ? NaN : n === 0 ? 1 : n + (err[n - 1]! - baseErr) / (err[n - 1]! - err[n]!);
    const v = variety(runs.map((r) => r.order), T);
    const untested = runs.reduce((a, r) => a + r.untested[T - 1]!, 0) / N;
    rows.push({ focus, match, err: err[T - 1], untested, ...v });
    console.log(`| ${focus}${focus === resolveLayout(data.layout).focus ? ' (current)' : ''} | ${Number.isNaN(match) ? `>${MAX_TESTS}` : match.toFixed(1)} | ${err[T - 1]!.toFixed(3)} | ${untested.toFixed(2)} | ${(v.firstTestShare * 100).toFixed(0)}% of runs | ${v.distinctSets} |`);
  }
  out.focus = rows;
}

await partA();
partB();
partC();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
