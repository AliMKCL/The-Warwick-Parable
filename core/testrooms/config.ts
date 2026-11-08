import { ARCHETYPES, type Archetype } from '../room/layouts';
import { TESTS } from './registry';

/** One pool entry: how likely a test is to be drawn, and an optional cap per run. */
export interface PoolEntry {
  weight: number;
  max?: number;
}

/** How a run is laid out (data/layout.json, with URL or test overrides). */
export interface LayoutConfig {
  /** Rooms that hold a test, between the waiting room and the finale. */
  tests: number;
  /** Rooms with no test (still furnished and inspectable). Lost gambles add one each. */
  fillers: number;
  /** Which tests can be drawn, and how often. A test not listed is never drawn. */
  pool: Record<string, PoolEntry>;
  /** Room layouts for filler rooms, with relative weights. */
  fillerLayouts: Partial<Record<Archetype, number>>;
  /**
   * How a test is drawn from the pool. 'adaptive' (default): pool weight × how much the
   * test is expected to teach about the traits the profile is least sure of (Bayesian
   * expected information gain). 'weighted': pool weight × each test's hand-written
   * profile heuristic (the original behaviour).
   */
  selection: Selection;
  /** Adaptive only: how hard the draw leans towards the most informative test (0 = not at all, 4 = default, 8+ = nearly always the best). */
  focus: number;
}

export type Selection = 'adaptive' | 'weighted';

/** The loose form found in data/layout.json and accepted as an override. */
export interface LayoutInput {
  tests?: number;
  fillers?: number;
  /** Weights by test id ({ "exit_timer": 1 }), entries ({ "gamble": { "weight": 1, "max": 2 } }), or just ids. */
  pool?: Record<string, number | { weight?: number; max?: number }> | string[];
  fillerLayouts?: Partial<Record<Archetype, number>>;
  selection?: Selection;
  focus?: number;
}

/**
 * The layout for a run: the data file, then the override on top. `runLength`
 * (the old ?rooms=N) keeps working: N rooms counting the waiting room and the
 * finale, as many tests as the config allows and the rest fillers.
 */
export function resolveLayout(base: LayoutInput, override: LayoutInput = {}, runLength?: number): LayoutConfig {
  const tests = Math.max(0, Math.floor(override.tests ?? base.tests ?? 4));
  let fillers = Math.max(0, Math.floor(override.fillers ?? base.fillers ?? 1));
  let t = tests;
  if (runLength !== undefined && Number.isFinite(runLength) && override.tests === undefined && override.fillers === undefined) {
    const middle = Math.max(1, Math.ceil(runLength) - 2);
    t = Math.min(tests, middle);
    fillers = middle - t;
  }
  const pool = normalisePool(override.pool ?? base.pool ?? Object.keys(TESTS), base.pool);
  const fillerLayouts = { ...(base.fillerLayouts ?? { waiting_room: 1, corridor: 1, open_office: 1, hub: 1, l_gallery: 0.65, u_gallery: 0.65 }), ...override.fillerLayouts };
  for (const k of Object.keys(fillerLayouts)) if (!(ARCHETYPES as readonly string[]).includes(k)) delete fillerLayouts[k as Archetype];
  const sel = override.selection ?? base.selection;
  const focus = Number(override.focus ?? base.focus ?? 4);
  return { tests: t, fillers, pool, fillerLayouts, selection: sel === 'weighted' ? 'weighted' : 'adaptive', focus: Number.isFinite(focus) ? Math.max(0, focus) : 4 };
}

/** A list of ids keeps the weights and caps the base gave them; weights alone keep the base caps; unknown ids are dropped. */
function normalisePool(pool: NonNullable<LayoutInput['pool']>, base?: LayoutInput['pool']): Record<string, PoolEntry> {
  const baseEntries = base && !Array.isArray(base) ? normalisePool(base) : {};
  const out: Record<string, PoolEntry> = {};
  const entries: [string, number | { weight?: number; max?: number }][] = Array.isArray(pool) ? pool.map((id) => [id, baseEntries[id] ?? 1]) : Object.entries(pool);
  for (const [id, v] of entries) {
    if (!TESTS[id]) continue;
    // A cap not given here comes from the data file's entry for the same test.
    const max = typeof v === 'number' ? baseEntries[id]?.max : v.max ?? baseEntries[id]?.max;
    const e = { weight: typeof v === 'number' ? v : v.weight ?? 1, ...(max !== undefined ? { max } : {}) };
    if (e.weight > 0) out[id] = e;
  }
  return out;
}
