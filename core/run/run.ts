import { describeVisit } from '../director/summary';
import { generateRoomContent } from '../director/content';
import { LlmError, type LlmClient } from '../llm/client';
import { OPPOSITE } from '../room/geometry';
import { CHOICE_ROOM, FINALE_HALL, generateLayout, orient, type Archetype } from '../room/layouts';
import { placeAssignments } from '../room/place';
import { applyRoomVariant } from '../room/variants';
import { templateAssignments } from '../room/templates';
import type { Door, GameData, Layout, RoomSpec, SelectionNote } from '../room/types';
import { roomFields, type RoomFields } from '../room/fields';
import { describePath, pathEvidence, PathTracker, type PathStats } from '../profile/path';
import { createRng, deriveSeed, pick } from '../util/random';
import type { GameEvent, ProfileSnapshot, RuleEffect, SelfRatings, TaskEvent, TaskResult } from '../protocol';
import { Profile } from '../profile/profile';
import { RuleRuntime, templateRuleLines, testLog, type RoomRule } from '../rules/rules';
import { computeBaseline, type Baseline } from '../testrooms/office/metrics';
import { resolveLayout, type LayoutConfig, type LayoutInput } from '../testrooms/config';
import { TESTS } from '../testrooms/registry';
import { pickRoom, usedCounts } from '../testrooms/schedule';
import { attachAnomaly, AnomalyRuntime } from '../anomalies/anomalies';
import type { AnomalyEffect } from '../protocol';

const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type GenStatus = 'queued' | 'generating' | 'ready' | 'fallback' | 'cancelled';

/** The room behind one exit: its layout exists at once, its content is generated in the background. */
interface Plan {
  doorId: string;
  index: number;
  seed: number;
  layout: Layout;
  entranceLabel: string;
  status: GenStatus;
  spec?: RoomSpec;
  done: Promise<RoomSpec>;
  resolve: (s: RoomSpec) => void;
  abort?: { abort(): void };
  error?: string;
  /** What this room is in the run's layout, and its test (core/testrooms). */
  slot: 'test' | 'filler' | 'finale';
  test?: string;
  /** The rule this room will run, made from its test when the room was planned. */
  rule?: Omit<RoomRule, 'line' | 'doneLine'>;
  /** Why its test was drawn. */
  selection?: SelectionNote;
}

/** One gamble the player faced, for the dossier and the said/did comparison. */
export interface GambleRecord {
  room: number;
  choice: 'safe' | 'risky';
  /** What happened: the certain room, or what the coin decided. */
  outcome: 'certain' | 'shortcut' | 'setback';
  timed: boolean;
  /** The clock ran out before they chose (so the 50/50 door was locked). */
  expired: boolean;
}

type RuleSpec = NonNullable<RoomSpec['rule']>;

export interface RunOptions {
  maxAnomalies?: number;
  onAnomaly?: (effect: AnomalyEffect) => void;
  llm?: LlmClient;
  /** How long a door waits for an unfinished room before falling back to templates. */
  waitMs?: number;
  /**
   * How long to watch the player in a new room before generating what lies
   * behind its doors, so the next rooms reflect what they did here too.
   * Lingering at a door starts that door's room at once.
   */
  observeMs?: number;
  onStatus?: (plans: { door: string; status: GenStatus; ms?: number; error?: string }[]) => void;
  /** A room rule changed the world. */
  onEffect?: (effect: RuleEffect) => void;
  /** A room rule wants the narrator to speak. */
  onSay?: (text: string) => void;
  /** The hidden profile changed. */
  onProfile?: (profile: ProfileSnapshot) => void;
  /** A test that scores itself (an office task) finished: what it measured, and its slice of the test log. */
  onTaskResult?: (result: TaskResult, log: TaskEvent[]) => void;
  /**
   * How the run is laid out: test and filler room counts and the test pool, on
   * top of data/layout.json (see core/testrooms/config.ts).
   */
  layout?: LayoutInput;
  /** Shorthand for the old ?rooms=N: N rooms counting the waiting room and the finale. `layout` wins. */
  runLength?: number;
  /**
   * Debug (`?layout=`): room types to use in turn from room 1 on. A test's own
   * room (lift lobby, choice room) makes that room the test, if one may go there.
   */
  forceArchetypes?: Archetype[];
  /**
   * How many rooms to generate at the same time (default 1). Set it to the
   * number of parallel requests the model server allows (OLLAMA_NUM_PARALLEL,
   * or LM Studio's Max Concurrent Predictions). Higher than the server allows
   * just queues there, and loses the lingered-at-door-first ordering.
   */
  concurrency?: number;
  now?: () => number;
}

/**
 * One playthrough. When the player enters a room, the room behind each exit
 * is laid out straight away and its content is generated in the background,
 * one exit at a time, the door the player lingers at first. Unchosen rooms
 * are thrown away, so a room exists only once the player commits to it.
 */
export class Run {
  readonly rooms: RoomSpec[] = [];
  readonly events: GameEvent[] = [];
  private plans: Plan[] = [];
  /** Rooms being generated right now. */
  private active = 0;
  /** False while the player is being observed in a freshly entered room. */
  private observing = false;
  private observeTimer: unknown;
  /** Set when the model server can't be reached; later rooms skip straight to templates. */
  modelOff = false;
  readonly profile: Profile;
  /** Story threads the model has planted, and whether a later room paid them off. */
  readonly threads: { id: string; text: string; room: number; resolvedIn?: number }[] = [];
  private rule?: RuleRuntime;
  /** Test and filler counts and the test pool for this run. */
  readonly layout: LayoutConfig;
  /**
   * The test log: moves, presses and answers that self-scoring tests (the
   * office tasks) record and score from. The waiting room's moves are logged
   * under 'baseline', for each player's own walking speed and input rate.
   */
  readonly taskLog = testLog();
  /** What each self-scoring test measured, in the order they finished. */
  readonly taskResults: TaskResult[] = [];
  private baselineCache?: Baseline;
  /** Every gamble the player has faced, in order. */
  readonly gambles: GambleRecord[] = [];
  /** Extra rooms added by lost gambles. */
  private detours = 0;
  /** The player's own ratings from the start screen, if given. */
  selfRatings?: SelfRatings;
  /** Run clock when each room's rule started, by room id. */
  readonly ruleStarts = new Map<string, number>();
  private anomaly?: AnomalyRuntime;
  /** How the player walked through each room they left (core/profile/path.ts), in order. */
  readonly paths: PathStats[] = [];
  /** Distance fields of the current room, built on entry. */
  fields?: RoomFields;
  private tracker?: PathTracker;
  /** Trait scores at the moment the player entered each room. */
  readonly traitHistory: Record<'hesitation' | 'curiosity' | 'compliance' | 'impulsivity', number>[] = [];

  constructor(
    readonly seed: number,
    private readonly data: GameData,
    private readonly opts: RunOptions = {},
  ) {
    if (!opts.llm) this.modelOff = true;
    this.profile = new Profile(data);
    this.layout = resolveLayout(data.layout ?? {}, opts.layout, opts.runLength);
  }

  get current(): RoomSpec | undefined {
    return this.rooms.at(-1);
  }

  /** The first room is built from templates so the game opens instantly; generation starts behind its doors. */
  start(): RoomSpec {
    const seed = deriveSeed(this.seed, 'room-0');
    const rng = createRng(seed);
    const layout = generateLayout({ archetype: 'waiting_room', entranceSide: 's', exits: 2, rng, doorLabels: this.data.templates.doorLabels });
    const spec = this.templateSpec({ index: 0, seed, layout, entranceLabel: '', slot: 'start' }, rng, { first: true, ambience: 'cold' });
    this.enter(spec);
    return spec;
  }

  record(event: GameEvent): void {
    if ('roomId' in event && event.roomId !== this.current?.id) return;
    // Position samples and raw input feed the running test and the baseline only, not the event log.
    if (event.type === 'move' || event.type === 'input') {
      if (event.type === 'move') this.tracker?.move(event.x, event.z, event.t);
      if (this.current?.index === 0) {
        const data = event.type === 'move' ? this.baselineMove(event.x, event.z, event.t) : { key: event.key, ...(event.target ? { target: event.target } : {}) };
        this.taskLog.emit('baseline', event.type, data, event.t);
      }
      this.rule?.onEvent(event);
      return;
    }
    this.events.push(event);
    const before = this.profile.evidence.length;
    if (event.type === 'room_entered' && this.fields && this.current) this.tracker = new PathTracker(this.current, this.fields, event.t);
    if (event.type === 'door_chosen' && this.tracker && this.current) {
      const path = this.tracker.finish(event.doorId, event.t);
      this.tracker = undefined;
      this.paths.push(path);
      pathEvidence(path, this.profile, this.current, event.t);
    }
    this.profile.observe(event, this.current, this.events);
    this.rule?.onEvent(event);
    this.anomaly?.onEvent(event);
    if (event.type === 'door_chosen' && this.current) this.settleTest(this.current);
    if (this.profile.evidence.length !== before) this.opts.onProfile?.(this.profile.snapshot());
    if (event.type === 'door_hovered') {
      this.prioritise(event.doorId);
      this.stopObserving();
    }
  }

  /** The player walked through `doorId`. Resolves with the next room, waiting at most `waitMs` for the model. */
  async next(doorId: string): Promise<RoomSpec> {
    const spec = await this.prepareNext(doorId);
    this.arrive(spec);
    return spec;
  }

  /** Stop observing the departed room while the player is physically in its corridor. */
  depart() {
    this.rule?.stop();
    this.rule = undefined;
    this.anomaly = undefined;
  }

  /** Prepare without counting the next room as visited or starting its rules. */
  async prepareNext(doorId: string, waitMs = this.opts.waitMs ?? 15000): Promise<RoomSpec> {
    const plan = this.plans.find((p) => p.doorId === doorId);
    if (!plan) throw new Error(`No exit "${doorId}" in the current room`);
    for (const other of this.plans) if (other !== plan) this.cancel(other);
    this.prioritise(doorId);
    this.stopObserving();

    let timer: unknown;
    const timeout = new Promise<'timeout'>((r) => { timer = timers.setTimeout(() => r('timeout'), waitMs); });
    const result = await Promise.race([plan.done, timeout]);
    timers.clearTimeout(timer);
    let spec = result === 'timeout' ? this.finishPreparation(doorId)! : result;
    spec = this.settleGamble(doorId, spec);
    if (plan.selection && spec.test === plan.test) spec.selection = plan.selection;
    this.decorate(spec);
    return spec;
  }

  /** End a bounded preparation wait with a complete template. Late model replies are discarded. */
  finishPreparation(doorId: string): RoomSpec | undefined {
    const plan = this.plans.find((p) => p.doorId === doorId);
    if (!plan) return;
    if (plan.spec) return plan.spec;
    this.cancel(plan);
    plan.spec = this.templateSpec(plan, createRng(plan.seed), { rule: plan.rule });
    plan.status = 'fallback';
    plan.resolve(plan.spec);
    this.emitStatus();
    return plan.spec;
  }

  arrive(spec: RoomSpec) {
    this.enter(spec, true);
  }

  /**
   * True when `doorId` is a won gamble right before the last room: the
   * shortcut skips that room and the run ends here. Records the gamble.
   */
  leavesEarly(doorId: string): boolean {
    const room = this.current, rule = room?.rule;
    if (!room || rule?.id !== 'gamble' || room.index + 1 < this.last) return false;
    if (doorId !== rule.params.risky || rule.params.risky === rule.params.safe || rule.params.outcome !== 'shortcut') return false;
    for (const p of this.plans) this.cancel(p);
    this.recordGamble(room, doorId);
    return true;
  }

  /**
   * Leaving a gamble room: the certain door gives the room as planned; the
   * 50/50 door applies the coin toss made when the room was created.
   * Shortcut: the next room's task is gone. Setback: one more room in the run.
   */
  private settleGamble(doorId: string, spec: RoomSpec): RoomSpec {
    const from = this.current;
    if (!from || from.rule?.id !== 'gamble') return spec;
    const outcome = this.recordGamble(from, doorId);
    if (outcome === 'shortcut') return { ...spec, rule: undefined, gambleResult: 'shortcut' };
    if (outcome === 'setback') {
      this.detours++;
      return { ...spec, gambleResult: 'setback' };
    }
    return spec;
  }

  private recordGamble(from: RoomSpec, doorId: string): GambleRecord['outcome'] {
    const rule = from.rule!;
    const risky = doorId === rule.params.risky && rule.params.risky !== rule.params.safe;
    const started = this.ruleStarts.get(from.id);
    const chosenAt = [...this.events].reverse().find((e) => e.type === 'door_chosen' && e.roomId === from.id)?.t;
    const seconds = Number(rule.params.seconds);
    const expired = seconds > 0 && started !== undefined && chosenAt !== undefined && chosenAt - started >= seconds;
    const outcome: GambleRecord['outcome'] = risky ? (rule.params.outcome === 'shortcut' ? 'shortcut' : 'setback') : 'certain';
    this.gambles.push({ room: from.index, choice: risky ? 'risky' : 'safe', outcome, timed: seconds > 0, expired });
    return outcome;
  }

  /** What the player did in a room, as sentences, plus what the profile noticed there. */
  describe(room: RoomSpec): string[] {
    const noticed = [...new Set(this.profile.evidence.filter((e) => e.room === room.index).map((e) => e.reason))];
    const lines = describeVisit(room, this.events, this.data);
    if (noticed.length) lines.push(`Noticed: ${noticed.join('; ')}.`);
    const measured = this.taskResults.filter((r) => r.room === room.index).flatMap((r) => r.notes);
    if (measured.length) lines.push(`Measured: ${measured.join(' ')}`);
    const path = this.paths.find((p) => p.room === room.index);
    const walked = path && describePath(path);
    if (walked) lines.push(walked);
    return lines;
  }

  /**
   * Leaving a test room whose test ran: any trait the test measures that got no
   * evidence in the room gets a neutral response (core/profile/profile.ts
   * `neutral`), so a test with a middling outcome still counts as asked.
   */
  private settleTest(room: RoomSpec) {
    const kind = room.rule && this.ruleStarts.has(room.id) ? TESTS[room.rule.id] : undefined;
    for (const m of kind?.measures ?? []) {
      if (!this.profile.evidence.some((e) => e.room === room.index && e.trait === m.trait)) this.profile.neutral(m.trait, m);
    }
  }

  /** The player's own baseline from the waiting room (walking speed, input rate…), for tests that compare against it. */
  baseline(): Baseline | null {
    if (this.current?.index === 0) return null;
    if (this.baselineCache) return this.baselineCache;
    const events = this.taskLog.slice('baseline');
    return events.length ? (this.baselineCache = computeBaseline(events)) : null;
  }

  private lastMove?: { t: number; x: number; z: number };
  private baselineMove(x: number, z: number, t: number) {
    const prev = this.lastMove;
    const dt = prev ? t - prev.t : 0;
    this.lastMove = { t, x, z };
    const v = (a: number, b: number) => (prev && dt > 0 ? Math.round(((a - b) / dt) * 1000) / 1000 : 0);
    return { x, z, vx: v(x, prev?.x ?? x), vz: v(z, prev?.z ?? z) };
  }

  /** One line per earlier room, for the story memory. */
  story(): string[] {
    return this.rooms.map((r) => {
      const resolved = r.thread?.resolves ? this.threads.find((t) => t.id === r.thread!.resolves) : undefined;
      return `Room ${r.index} "${r.title}"${r.anomaly ? ` (contained ${r.anomaly.id})` : ''}${r.fact ? `: ${r.fact}` : ''}${resolved ? ` (paid off thread: ${resolved.text})` : ''}`;
    });
  }

  /** Index of the finale: after the waiting room, every test and filler room, and any detours from lost gambles. */
  get last(): number {
    return this.layout.tests + this.layout.fillers + 1 + this.detours;
  }

  /** True once the player has reached the last room of the run. */
  get finished(): boolean {
    return (this.current?.index ?? 0) >= this.last;
  }

  /**
   * Start the current room's rule. Called once the room is on screen and the
   * narrator has introduced it; `t` is the run clock at that moment.
   */
  startRule(t: number) {
    this.rule?.stop();
    this.rule = undefined;
    const room = this.current;
    if (!room?.rule) return;
    this.ruleStarts.set(room.id, t);
    this.rule = new RuleRuntime(room.rule as RoomRule, {
      room,
      profile: this.profile,
      emit: (e) => this.opts.onEffect?.(e),
      say: (text) => text && this.opts.onSay?.(text),
      rng: createRng(deriveSeed(room.seed, 'rule')),
      data: this.data,
      log: this.taskLog,
      report: (result) => {
        this.taskResults.push(result);
        this.opts.onTaskResult?.(result, this.taskLog.slice(result.task));
        this.opts.onProfile?.(this.profile.snapshot());
      },
      baseline: () => this.baseline(),
    });
    this.rule.start(t, this.events);
  }

  plansStatus() {
    return this.plans.map((p) => ({ door: p.doorId, status: p.status, ms: p.spec?.genMs, error: p.error }));
  }

  // ---------- internals ----------

  private decorate(room: RoomSpec) {
    const previous = this.current;
    const choice = [...this.events].reverse().find((e) => e.type === 'door_chosen' && e.roomId === previous?.id);
    // Set-piece tests (the choice room, the lift lobby) and the finale get no messy/ceiling variant or anomaly on top.
    const plain = (room.test && TESTS[room.test]?.setPiece) || room.slot === 'finale';
    if (!plain) {
      applyRoomVariant(room, this.rooms, this.last);
      if (!room.variant) attachAnomaly(room, this.rooms, this.events, this.data, this.last, this.seed, this.opts.maxAnomalies);
    }
    if (!plain && previous?.anomaly?.id === 'blue_door' && choice?.type === 'door_chosen' && choice.doorId === previous.anomaly.doorId) {
      const callback = `Returned to your file. ${previous.anomaly.record} You may wish to reconsider the wording.`;
      room.narrator.onEnter = room.variant ? `${room.narrator.onEnter} ${callback}` : callback;
      room.fact = [room.fact, previous.anomaly.record].filter(Boolean).join(' ');
    }
  }

  private enter(room: RoomSpec, decorated = false) {
    this.depart();
    if (!decorated) this.decorate(room);
    this.anomaly = new AnomalyRuntime(room, this.events, (e) => this.opts.onAnomaly?.(e),
      (line) => this.opts.onSay?.(line), (t) => this.rule?.borrowTime(t, 8) ?? false);
    this.rooms.push(room);
    this.traitHistory.push({ ...this.profile.traits });
    // Walking distance to every exit from every cell, once per room: position samples are then read by table lookup.
    this.fields = roomFields(room, this.data, () => this.now());
    this.tracker = undefined;
    if (room.thread?.plant) this.threads.push({ id: `t${this.threads.length + 1}`, text: room.thread.plant, room: room.index });
    const resolved = this.threads.find((t) => t.id === room.thread?.resolves);
    if (resolved && resolved.resolvedIn === undefined) resolved.resolvedIn = room.index;
    // The final room's exit leads to the player's file, not to another room.
    this.plans = room.index >= this.last ? [] : room.layout.doors.filter((d) => !d.entrance).map((d) => this.plan(room, d));
    this.emitStatus();
    timers.clearTimeout(this.observeTimer);
    this.observing = true;
    this.observeTimer = timers.setTimeout(() => this.stopObserving(), this.opts.observeMs ?? 8000);
  }

  private stopObserving() {
    timers.clearTimeout(this.observeTimer);
    this.observing = false;
    this.pump();
  }

  /** The room behind one door: decided now (test or filler, which test, which layout), written in the background. */
  private plan(from: RoomSpec, door: Door): Plan {
    const index = from.index + 1;
    const seed = deriveSeed(this.seed, `room-${index}-${from.id}-${door.id}`);
    const rng = createRng(seed);
    const pick = pickRoom({ config: this.layout, rooms: this.rooms, index, last: this.last, detours: this.detours, profile: this.profile, forced: this.nextForced() }, createRng(deriveSeed(seed, 'pick-room')));
    // A test with its own room builds it (and its settings); every other room comes from the layout generator.
    const own = pick.test?.room?.({ seed, rng, data: this.data, profile: this.profile });
    const layout = own
      ? orient(own.layout, OPPOSITE[door.side])
      : generateLayout({
        archetype: pick.archetype as Archetype,
        entranceSide: OPPOSITE[door.side],
        exits: pick.exits,
        rng,
        doorLabels: this.data.templates.doorLabels,
      });
    let resolve!: (s: RoomSpec) => void;
    const done = new Promise<RoomSpec>((r) => (resolve = r));
    const p: Plan = { doorId: door.id, index, seed, layout, entranceLabel: door.label, status: 'queued', done, resolve, slot: pick.slot };
    if (pick.test) {
      p.test = pick.test.id;
      p.selection = pick.selection;
      const params = own ? own.params : pick.test.params({ layout, rng: createRng(deriveSeed(seed, 'test-params')), profile: this.profile, used: usedCounts(this.rooms) });
      if (params) p.rule = { id: pick.test.id, params };
    }
    return p;
  }

  /** The next room type from `forceArchetypes` still to be placed. */
  private nextForced(): Archetype | undefined {
    const list = this.opts.forceArchetypes;
    if (!list?.length) return undefined;
    let placed = 0;
    for (const r of this.rooms.slice(1)) if (r.layout.archetype === list[placed % list.length]) placed++;
    return list[placed % list.length];
  }

  private prioritise(doorId: string) {
    const i = this.plans.findIndex((p) => p.doorId === doorId);
    if (i > 0) this.plans.unshift(...this.plans.splice(i, 1));
  }

  private cancel(plan: Plan) {
    if (plan.status === 'queued' || plan.status === 'generating') {
      plan.abort?.abort();
      plan.status = 'cancelled';
      this.emitStatus();
    }
  }

  /** Starts queued plans, in priority order, up to `concurrency` at a time. */
  private pump() {
    if (this.observing) return;
    const limit = Math.max(1, this.opts.concurrency ?? 1);
    while (this.active < limit) {
      const plan = this.plans.find((p) => p.status === 'queued');
      if (!plan) return;
      void this.generate(plan);
    }
  }

  private async generate(plan: Plan) {
    this.active++;
    plan.status = 'generating';
    this.emitStatus();
    const rng = createRng(plan.seed);
    const rule = plan.rule;
    const templatesOnly = plan.test !== undefined && TESTS[plan.test]?.modelWritten === false;
    let spec: RoomSpec;
    if (templatesOnly || this.modelOff) {
      spec = this.templateSpec(plan, rng, { rule });
    } else {
      spec = await this.modelSpec(plan, rng, rule).catch((err: unknown) => {
        const e = err as LlmError;
        plan.error = e.message;
        if (e instanceof LlmError && e.kind === 'unreachable') this.modelOff = true;
        return this.templateSpec(plan, createRng(plan.seed), { rule });
      });
    }
    if (plan.status === 'generating') {
      plan.status = spec.source === 'model' ? 'ready' : 'fallback';
      plan.spec = spec;
      plan.resolve(spec);
    }
    this.active--;
    this.emitStatus();
    this.pump();
  }

  private async modelSpec(plan: Plan, rng: ReturnType<typeof createRng>, rule?: Omit<RoomRule, 'line' | 'doneLine'>): Promise<RoomSpec> {
    const Abort = (globalThis as unknown as { AbortController?: new () => { abort(): void; signal: unknown } }).AbortController;
    const controller = Abort ? new Abort() : undefined;
    plan.abort = controller;
    const started = this.now();
    const behaviour = this.behaviourLog();
    const profile = this.profile.readout();
    const gen = await generateRoomContent(
      this.opts.llm!,
      {
        index: plan.index,
        layout: plan.layout,
        entranceLabel: plan.entranceLabel,
        story: this.story(),
        behaviour,
        profile,
        rule,
        threads: this.threads.filter((t) => t.resolvedIn === undefined).map(({ id, text }) => ({ id, text })),
        runLength: this.last + 1,
        data: this.data,
      },
      rng,
      controller?.signal,
    );
    const c = gen.content;
    const furniture = templateAssignments(plan.layout, this.data, rng, { index: plan.index, skip: gen.modelSlots, plainOnly: true });
    const { props } = placeAssignments(plan.layout, [...gen.assignments, ...furniture], this.data);
    const labels = new Map(c.doors.map((d) => [d.door, d.label.toUpperCase().slice(0, 16)]));
    const layout: Layout = { ...plan.layout, doors: plan.layout.doors.map((d) => (labels.has(d.id) && !d.fixedLabel ? { ...d, label: labels.get(d.id)! } : { ...d, label: d.entrance ? plan.entranceLabel : d.label })) };
    return this.dress({
      id: `room-${plan.index}-${plan.seed.toString(36)}`,
      slot: plan.slot,
      test: plan.test,
      index: plan.index,
      seed: plan.seed,
      layout,
      props,
      ambience: this.data.ambience[c.ambience] ? c.ambience : 'cold',
      narrator: {
        onEnter: c.narrator_enter,
        doors: Object.fromEntries(c.doors.map((d) => [d.door, d.line])),
      },
      source: 'model',
      title: c.title || layout.archetype,
      fact: c.fact,
      genMs: Math.round(this.now() - started),
      rule: rule && {
        ...rule,
        params: TESTS[rule.id]?.picksDoor ? { ...rule.params, door: c.suggest_door ?? '' } : rule.params,
        line: c.rule_line,
        doneLine: c.rule_done_line || this.data.templates.rules[rule.id]?.done[0] || '',
      },
      provenance: { behaviour, profile, story: this.story(), repaired: gen.repaired },
      thread: {
        plant: c.thread_plant?.trim() || undefined,
        resolves: c.thread_resolve && c.thread_resolve !== 'none' ? c.thread_resolve : undefined,
      },
    });
  }

  private templateSpec(
    plan: Pick<Plan, 'index' | 'seed' | 'layout' | 'entranceLabel' | 'test'> & { slot: RoomSpec['slot'] },
    rng: ReturnType<typeof createRng>,
    o: { first?: boolean; ambience?: string; rule?: Omit<RoomRule, 'line' | 'doneLine'> } = {},
  ): RoomSpec {
    const { layout } = plan;
    const t = this.data.templates;
    const isChoice = layout.archetype === CHOICE_ROOM;
    const assignments = templateAssignments(layout, this.data, rng, { index: plan.index, forceCenter: o.first ? 'button_pedestal' : undefined });
    const { props } = placeAssignments(layout, assignments, this.data);
    const spec: RoomSpec = {
      id: `room-${plan.index}-${plan.seed.toString(36)}`,
      slot: plan.slot,
      test: plan.test,
      index: plan.index,
      seed: plan.seed,
      layout: { ...layout, doors: layout.doors.map((d) => (d.entrance ? { ...d, label: plan.entranceLabel } : d)) },
      props,
      ambience: isChoice ? 'cold' : o.ambience ?? pick(rng, Object.keys(this.data.ambience)),
      narrator: {
        onEnter: o.first ? pick(rng, t.narratorFirst) : pick(rng, t.narratorEnter[layout.archetype] ?? t.narratorEnter.default ?? t.narratorFirst),
        doors: isChoice ? {} : Object.fromEntries(layout.doors.filter((d) => !d.entrance).map((d) => [d.id, pick(rng, t.narratorDoor)])),
      },
      source: 'template',
      title: o.first ? 'The waiting room' : isChoice ? 'Choice Room' : layout.archetype === FINALE_HALL ? 'The last hallway' : layout.archetype.replaceAll('_', ' '),
      provenance: o.first ? undefined : { behaviour: this.behaviourLog(), profile: this.profile.readout(), story: this.story(), error: (plan as Partial<Plan>).error },
    };
    if (o.rule) {
      const exits = layout.doors.filter((d) => !d.entrance);
      const params = TESTS[o.rule.id]?.picksDoor ? { ...o.rule.params, door: pick(rng, exits).id } : o.rule.params;
      const rule = { ...o.rule, params };
      spec.rule = { ...rule, ...templateRuleLines(rule, spec, this.data, rng) } as RuleSpec;
    }
    return this.dress(spec);
  }

  /** The room's test gets the last word on its spec (the gamble tags its doors and spells out the stakes). */
  private dress(spec: RoomSpec): RoomSpec {
    const kind = spec.rule ? TESTS[spec.rule.id] : undefined;
    return kind?.dress ? kind.dress(spec, this.data) : spec;
  }

  /** Behaviour across the whole run so far, room by room. */
  private behaviourLog(): string[] {
    return this.rooms.flatMap((r) => {
      const lines = this.describe(r);
      return lines.length ? [`In room ${r.index} "${r.title}": ${lines.join(' ')}`] : [];
    });
  }

  private emitStatus() {
    this.opts.onStatus?.(this.plansStatus());
  }

  private now() {
    return (this.opts.now ?? (() => Date.now()))();
  }
}
