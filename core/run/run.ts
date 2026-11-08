import { describeVisit } from '../director/summary';
import { generateRoomContent } from '../director/content';
import { LlmError, type LlmClient } from '../llm/client';
import { OPPOSITE } from '../room/geometry';
import { ARCHETYPES, CHOICE_ROOM, generateLayout, type Archetype } from '../room/layouts';
import { placeAssignments } from '../room/place';
import { applyRoomVariant } from '../room/variants';
import { templateAssignments } from '../room/templates';
import type { Door, GameData, Layout, RoomSpec } from '../room/types';
import { createRng, deriveSeed, pick, randInt } from '../util/random';
import type { GameEvent, ProfileSnapshot, RuleEffect, SelfRatings } from '../protocol';
import { Profile } from '../profile/profile';
import { chooseRule, gambleRule, liftRule, GAMBLE_LABELS, RuleRuntime, templateRuleLines, type RoomRule, type RuleId } from '../rules/rules';
import { attachAnomaly, AnomalyRuntime } from '../anomalies/anomalies';
import type { AnomalyEffect } from '../protocol';
import { RUN_LENGTH } from '../director/prompts';

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
  /** The rule this room will run, once chosen (gamble rooms know theirs from the start). */
  rule?: Omit<RoomRule, 'line' | 'doneLine'>;
  /** Chosen yet? (`rule` may legitimately be undefined.) */
  ruled?: boolean;
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

/**
 * Which rooms hold a gamble: up to three, spread through the run, never two
 * in a row (so the room behind a gamble is always an ordinary room) and none
 * in the first or last room. The middle one is on a clock. Runs shorter than
 * five rooms have none.
 */
export function gamblePlan(last: number): Map<number, { timed: boolean }> {
  const n = last - 1; // rooms 1 .. last-1 can hold one
  const out = new Map<number, { timed: boolean }>();
  if (n < 3) return out;
  const k = Math.min(3, Math.ceil(n / 2));
  const at = Array.from({ length: k }, (_, j) => Math.round(1 + (j * (n - 1)) / (k - 1)));
  at.forEach((i, j) => out.set(i, { timed: j === 1 }));
  return out;
}

/**
 * Where the two-door choice room goes: at most one per run. Never a gamble
 * room (the gamble's two doors are the choice there), never the room behind
 * one (it needs a task for a won gamble to skip), never the final room (the
 * finale is written by the model). -1 if no room fits: in a 7-room run the
 * gambles take rooms 1, 3 and 5, so it appears in shorter or longer runs.
 */
export function choiceRoomFor(seed: number, last: number, gambles: Map<number, unknown>): number {
  const open = Array.from({ length: Math.max(0, last - 1) }, (_, i) => i + 1).filter((i) => !gambles.has(i));
  const pool = open.filter((i) => !gambles.has(i - 1));
  return pool.length ? pool[randInt(createRng(deriveSeed(seed, CHOICE_ROOM)), 0, pool.length - 1)]! : -1;
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
  /** Rooms in the run, counting the first (default 7). */
  runLength?: number;
  /**
   * Debug (`?layout=`): room types to use in turn from room 1 on. Each goes in
   * the first room it fits: a lift lobby skips gamble rooms and the final room.
   */
  forceArchetypes?: (typeof ARCHETYPES)[number][];
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
  /** Where the two-door choice room goes (-1: none this run). */
  private readonly choiceRoomIndex: number;
  /** False while the player is being observed in a freshly entered room. */
  private observing = false;
  private observeTimer: unknown;
  /** Set when the model server can't be reached; later rooms skip straight to templates. */
  modelOff = false;
  readonly profile: Profile;
  /** Story threads the model has planted, and whether a later room paid them off. */
  readonly threads: { id: string; text: string; room: number; resolvedIn?: number }[] = [];
  private rule?: RuleRuntime;
  /** Room index -> gamble, fixed at the start from the run's length. */
  readonly gambleRooms: Map<number, { timed: boolean }>;
  /** Every gamble the player has faced, in order. */
  readonly gambles: GambleRecord[] = [];
  /** Extra rooms added by lost gambles. */
  private detours = 0;
  /** The player's own ratings from the start screen, if given. */
  selfRatings?: SelfRatings;
  /** Run clock when each room's rule started, by room id. */
  readonly ruleStarts = new Map<string, number>();
  private anomaly?: AnomalyRuntime;
  /** Trait scores at the moment the player entered each room. */
  readonly traitHistory: Record<'hesitation' | 'curiosity' | 'compliance' | 'impulsivity', number>[] = [];

  constructor(
    readonly seed: number,
    private readonly data: GameData,
    private readonly opts: RunOptions = {},
  ) {
    if (!opts.llm) this.modelOff = true;
    this.profile = new Profile(data);
    this.gambleRooms = gamblePlan(this.baseLast);
    this.choiceRoomIndex = choiceRoomFor(seed, this.baseLast, this.gambleRooms);
  }

  get current(): RoomSpec | undefined {
    return this.rooms.at(-1);
  }

  /** The first room is built from templates so the game opens instantly; generation starts behind its doors. */
  start(): RoomSpec {
    const seed = deriveSeed(this.seed, 'room-0');
    const rng = createRng(seed);
    const layout = generateLayout({ archetype: 'waiting_room', entranceSide: 's', exits: 2, rng, doorLabels: this.data.templates.doorLabels });
    const spec = this.templateSpec({ index: 0, seed, layout, entranceLabel: '' }, rng, { first: true, ambience: 'cold' });
    this.enter(spec);
    return spec;
  }

  record(event: GameEvent): void {
    if ('roomId' in event && event.roomId !== this.current?.id) return;
    this.events.push(event);
    const before = this.profile.evidence.length;
    this.profile.observe(event, this.current, this.events);
    this.rule?.onEvent(event);
    this.anomaly?.onEvent(event);
    if (this.profile.evidence.length !== before) this.opts.onProfile?.(this.profile.snapshot());
    if (event.type === 'door_hovered') {
      this.prioritise(event.doorId);
      this.stopObserving();
    }
  }

  /** The player walked through `doorId`. Resolves with the next room, waiting at most `waitMs` for the model. */
  async next(doorId: string): Promise<RoomSpec> {
    const plan = this.plans.find((p) => p.doorId === doorId);
    if (!plan) throw new Error(`No exit "${doorId}" in the current room`);
    for (const other of this.plans) if (other !== plan) this.cancel(other);
    this.prioritise(doorId);
    this.stopObserving();

    const waitMs = this.opts.waitMs ?? 15000;
    const timeout = new Promise<'timeout'>((r) => timers.setTimeout(() => r('timeout'), waitMs));
    const result = await Promise.race([plan.done, timeout]);
    let spec: RoomSpec;
    if (result === 'timeout') {
      this.cancel(plan);
      spec = this.templateSpec(plan, createRng(plan.seed), { rule: plan.ruled ? plan.rule : undefined });
    } else {
      spec = result;
    }
    spec = this.settleGamble(doorId, spec);
    this.enter(spec);
    return spec;
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
    return lines;
  }

  /** One line per earlier room, for the story memory. */
  story(): string[] {
    return this.rooms.map((r) => {
      const resolved = r.thread?.resolves ? this.threads.find((t) => t.id === r.thread!.resolves) : undefined;
      return `Room ${r.index} "${r.title}"${r.anomaly ? ` (contained ${r.anomaly.id})` : ''}${r.fact ? `: ${r.fact}` : ''}${resolved ? ` (paid off thread: ${resolved.text})` : ''}`;
    });
  }

  /** Index of the final room, including any detours added by lost gambles. */
  get last(): number {
    return this.baseLast + this.detours;
  }

  /** Index of the final room as planned at the start. */
  private get baseLast(): number {
    const length = this.opts.runLength ?? RUN_LENGTH;
    return Number.isFinite(length) ? Math.max(2, Math.ceil(length) - 1) : RUN_LENGTH - 1;
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
    });
    this.rule.start(t, this.events);
  }

  plansStatus() {
    return this.plans.map((p) => ({ door: p.doorId, status: p.status, ms: p.spec?.genMs, error: p.error }));
  }

  // ---------- internals ----------

  private enter(room: RoomSpec) {
    this.rule?.stop();
    this.rule = undefined;
    const previous = this.current;
    const choice = [...this.events].reverse().find((e) => e.type === 'door_chosen' && e.roomId === previous?.id);
    // The choice room and the lift lobby are set pieces: no messy/ceiling variant or anomaly on top.
    if (room.layout.archetype !== CHOICE_ROOM && room.layout.archetype !== 'lift_lobby') {
      applyRoomVariant(room, this.rooms, this.last);
      if (!room.variant) attachAnomaly(room, this.rooms, this.events, this.data, this.last, this.seed, this.opts.maxAnomalies);
    }
    if (room.layout.archetype !== CHOICE_ROOM && previous?.anomaly?.id === 'blue_door' && choice?.type === 'door_chosen' && choice.doorId === previous.anomaly.doorId) {
      const callback = `Returned to your file. ${previous.anomaly.record} You may wish to reconsider the wording.`;
      room.narrator.onEnter = room.variant ? `${room.narrator.onEnter} ${callback}` : callback;
      room.fact = [room.fact, previous.anomaly.record].filter(Boolean).join(' ');
    }
    this.anomaly = new AnomalyRuntime(room, this.events, (e) => this.opts.onAnomaly?.(e),
      (line) => this.opts.onSay?.(line), (t) => this.rule?.borrowTime(t, 8) ?? false);
    this.rooms.push(room);
    this.traitHistory.push({ ...this.profile.traits });
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

  private plan(from: RoomSpec, door: Door): Plan {
    const index = from.index + 1;
    const seed = deriveSeed(this.seed, `room-${index}-${from.id}-${door.id}`);
    const rng = createRng(seed);
    const { archetype, exits } = index === this.choiceRoomIndex
      ? { archetype: CHOICE_ROOM, exits: 2 } as const
      : this.dials(from, rng);
    const layout = generateLayout({
      archetype,
      entranceSide: OPPOSITE[door.side],
      exits,
      rng,
      doorLabels: this.data.templates.doorLabels,
    });
    let resolve!: (s: RoomSpec) => void;
    const done = new Promise<RoomSpec>((r) => (resolve = r));
    const p: Plan = { doorId: door.id, index, seed, layout, entranceLabel: door.label, status: 'queued', done, resolve };
    const gamble = this.gambleRooms.get(index);
    if (gamble && index < this.last) {
      const exits = layout.doors.filter((d) => !d.entrance).map((d) => d.id);
      if (exits.length >= 2) {
        p.rule = gambleRule(exits, createRng(deriveSeed(seed, 'gamble')), gamble.timed);
        p.ruled = true;
      }
    }
    return p;
  }

  /**
   * The profile shapes the space: hesitant players get more doors and long
   * corridors, curious ones get rooms full of things, impulsive ones get
   * fewer choices.
   */
  private dials(from: RoomSpec, rng: ReturnType<typeof createRng>): { archetype: Archetype; exits: number } {
    const t = this.profile.traits;
    const index = from.index + 1;
    const final = index >= this.last;
    const gamble = this.gambleRooms.has(index);
    const forced = this.nextForced();
    // L and U rooms are a little rarer than the four basic types; the lift lobby is a set piece, at most once per run.
    const w: Record<(typeof ARCHETYPES)[number], number> = {
      waiting_room: 1, corridor: 1, open_office: 1, hub: 1, l_gallery: 0.65, u_gallery: 0.65, lift_lobby: 0.45,
    };
    if (t.hesitation > 0.6) { w.corridor += 1.5; w.hub += 1; w.lift_lobby += 0.4; }
    if (t.curiosity > 0.6) { w.open_office += 1.5; w.hub += 0.5; w.l_gallery += 0.3; w.u_gallery += 0.3; }
    if (t.impulsivity > 0.6) { w.corridor += 1; w.waiting_room += 0.5; }
    // A hub always has at least two exits, so it can't be the final room (one way on, to the file).
    // The lift lobby has one exit, so it can't hold a gamble either.
    const liftUsed = this.rooms.some((r) => r.layout.archetype === 'lift_lobby');
    const options = ARCHETYPES.filter((a) => a !== from.layout.archetype && !(a === 'hub' && final) && !(a === 'lift_lobby' && (liftUsed || final || gamble)));
    let archetype = options[0]!;
    if (forced && !(forced === 'lift_lobby' && (final || gamble)) && !(forced === 'hub' && final)) archetype = forced;
    else {
      const total = options.reduce((a, k) => a + w[k], 0);
      let r = rng() * total;
      for (const k of options) if ((r -= w[k]) <= 0) { archetype = k; break; }
    }
    let exits = 1 + Math.floor(rng() * 3);
    if (t.hesitation > 0.62) exits = 3;
    else if (t.impulsivity > 0.62) exits = Math.min(exits, 2);
    if (final) exits = 1; // the last room has one way on
    else if (gamble) exits = 2; // a gamble: certain or 50/50
    return { archetype, exits };
  }

  /** The next room type from `forceArchetypes` still to be placed. */
  private nextForced(): (typeof ARCHETYPES)[number] | undefined {
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
    const isChoice = plan.layout.archetype === CHOICE_ROOM;
    // Behind a gamble the room always has a task, so the shortcut has something to skip.
    // (The last room never has one: there the shortcut skips the room itself.)
    const afterGamble = this.current?.rule?.id === 'gamble';
    if (!plan.ruled) {
      plan.rule = isChoice || plan.index >= this.last ? undefined
        : plan.layout.archetype === 'lift_lobby' ? liftRule(plan.layout, createRng(deriveSeed(plan.seed, 'pick-rule')))
        : chooseRule(this.profile, createRng(deriveSeed(plan.seed, 'pick-rule')), plan.index, this.current?.rule?.id as RuleId | undefined, afterGamble);
      plan.ruled = true;
    }
    const rule = plan.rule;
    let spec: RoomSpec;
    if (isChoice || this.modelOff) {
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
    return this.dressGamble({
      id: `room-${plan.index}-${plan.seed.toString(36)}`,
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
        params: rule.id === 'narrator_suggests' ? { ...rule.params, door: c.suggest_door ?? '' } : rule.params,
        line: c.rule_line,
        doneLine: c.rule_done_line || this.data.templates.rules[rule.id].done[0]!,
      },
      provenance: { behaviour, profile, story: this.story(), repaired: gen.repaired },
      thread: {
        plant: c.thread_plant?.trim() || undefined,
        resolves: c.thread_resolve && c.thread_resolve !== 'none' ? c.thread_resolve : undefined,
      },
    });
  }

  private templateSpec(
    plan: Pick<Plan, 'index' | 'seed' | 'layout' | 'entranceLabel'>,
    rng: ReturnType<typeof createRng>,
    o: { first?: boolean; ambience?: string; rule?: Omit<RoomRule, 'line' | 'doneLine'> } = {},
  ): RoomSpec {
    const { layout } = plan;
    const t = this.data.templates;
    const isChoice = layout.archetype === CHOICE_ROOM;
    // A lift lobby without its lift rule would be a room with a lift that does nothing.
    if (!o.rule && layout.archetype === 'lift_lobby' && plan.index < this.last) o = { ...o, rule: liftRule(layout, createRng(deriveSeed(plan.seed, 'pick-rule'))) };
    const assignments = templateAssignments(layout, this.data, rng, { index: plan.index, forceCenter: o.first ? 'button_pedestal' : undefined });
    const { props } = placeAssignments(layout, assignments, this.data);
    const spec: RoomSpec = {
      id: `room-${plan.index}-${plan.seed.toString(36)}`,
      index: plan.index,
      seed: plan.seed,
      layout: { ...layout, doors: layout.doors.map((d) => (d.entrance ? { ...d, label: plan.entranceLabel } : d)) },
      props,
      ambience: isChoice ? 'cold' : o.ambience ?? pick(rng, Object.keys(this.data.ambience)),
      narrator: {
        onEnter: o.first ? pick(rng, t.narratorFirst) : pick(rng, t.narratorEnter[layout.archetype] ?? t.narratorFirst),
        doors: isChoice ? {} : Object.fromEntries(layout.doors.filter((d) => !d.entrance).map((d) => [d.id, pick(rng, t.narratorDoor)])),
      },
      source: 'template',
      title: o.first ? 'The waiting room' : isChoice ? 'Choice Room' : layout.archetype.replaceAll('_', ' '),
      provenance: o.first ? undefined : { behaviour: this.behaviourLog(), profile: this.profile.readout(), story: this.story(), error: (plan as Partial<Plan>).error },
    };
    if (o.rule) {
      const exits = layout.doors.filter((d) => !d.entrance);
      const params = o.rule.id === 'narrator_suggests' ? { ...o.rule.params, door: pick(rng, exits).id } : o.rule.params;
      const rule = { ...o.rule, params };
      spec.rule = { ...rule, ...templateRuleLines(rule, spec, this.data, rng) } as RuleSpec;
    }
    return this.dressGamble(spec);
  }

  /**
   * A gamble room states its stakes plainly, whoever wrote the rest: the two
   * door labels are tagged CERTAIN and 50/50, looking at either says what it
   * does, and the stakes line comes from templates so it can never be vague.
   */
  private dressGamble(spec: RoomSpec): RoomSpec {
    const rule = spec.rule;
    if (rule?.id !== 'gamble') return spec;
    const rng = createRng(deriveSeed(spec.seed, 'gamble-lines'));
    const g = this.data.templates.gamble;
    const safe = String(rule.params.safe), risky = String(rule.params.risky);
    const { line: stakes } = templateRuleLines(rule, spec, this.data, rng);
    const tag = (label: string, t: string) => `${label.slice(0, 16 - t.length - 3).trim()} · ${t}`.replace(/^ · /, '');
    return {
      ...spec,
      layout: { ...spec.layout, doors: spec.layout.doors.map((d) => (d.id === safe ? { ...d, label: tag(d.label, GAMBLE_LABELS.safe) } : d.id === risky ? { ...d, label: tag(d.label, GAMBLE_LABELS.risky) } : d)) },
      narrator: { ...spec.narrator, doors: { ...spec.narrator.doors, [safe]: pick(rng, g.safeDoor), [risky]: pick(rng, g.riskyDoor) } },
      rule: { ...rule, params: { ...rule.params, stakes } },
    };
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
