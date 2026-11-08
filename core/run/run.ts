import { describeVisit } from '../director/summary';
import { generateRoomContent } from '../director/content';
import { LlmError, type LlmClient } from '../llm/client';
import { OPPOSITE } from '../room/geometry';
import { ARCHETYPES, generateLayout, type Archetype } from '../room/layouts';
import { placeAssignments } from '../room/place';
import { templateAssignments } from '../room/templates';
import type { Door, GameData, Layout, RoomSpec } from '../room/types';
import { createRng, deriveSeed, pick } from '../util/random';
import type { GameEvent, ProfileSnapshot, RuleEffect } from '../protocol';
import { Profile } from '../profile/profile';
import { chooseRule, RuleRuntime, templateRuleLines, type RoomRule, type RuleId } from '../rules/rules';
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
}

type RuleSpec = NonNullable<RoomSpec['rule']>;

export interface RunOptions {
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
  private working = false;
  /** False while the player is being observed in a freshly entered room. */
  private observing = false;
  private observeTimer: unknown;
  /** Set when the model server can't be reached; later rooms skip straight to templates. */
  modelOff = false;
  readonly profile: Profile;
  /** Story threads the model has planted, and whether a later room paid them off. */
  readonly threads: { id: string; text: string; room: number; resolvedIn?: number }[] = [];
  private rule?: RuleRuntime;
  /** Trait scores at the moment the player entered each room. */
  readonly traitHistory: Record<'hesitation' | 'curiosity' | 'compliance' | 'impulsivity', number>[] = [];

  constructor(
    readonly seed: number,
    private readonly data: GameData,
    private readonly opts: RunOptions = {},
  ) {
    if (!opts.llm) this.modelOff = true;
    this.profile = new Profile(data);
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
    this.events.push(event);
    const before = this.profile.evidence.length;
    this.profile.observe(event, this.current, this.events);
    this.rule?.onEvent(event);
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
      spec = this.templateSpec(plan, createRng(plan.seed));
    } else {
      spec = result;
    }
    this.enter(spec);
    return spec;
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
      return `Room ${r.index} "${r.title}"${r.fact ? `: ${r.fact}` : ''}${resolved ? ` (paid off thread: ${resolved.text})` : ''}`;
    });
  }

  /** Index of the final room. */
  get last(): number {
    return Math.max(2, (this.opts.runLength ?? RUN_LENGTH) - 1);
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
    void this.pump();
  }

  private plan(from: RoomSpec, door: Door): Plan {
    const index = from.index + 1;
    const seed = deriveSeed(this.seed, `room-${index}-${from.id}-${door.id}`);
    const rng = createRng(seed);
    const { archetype, exits } = this.dials(from, rng);
    const layout = generateLayout({
      archetype,
      entranceSide: OPPOSITE[door.side],
      exits,
      rng,
      doorLabels: this.data.templates.doorLabels,
    });
    let resolve!: (s: RoomSpec) => void;
    const done = new Promise<RoomSpec>((r) => (resolve = r));
    return { doorId: door.id, index, seed, layout, entranceLabel: door.label, status: 'queued', done, resolve };
  }

  /**
   * The profile shapes the space: hesitant players get more doors and long
   * corridors, curious ones get rooms full of things, impulsive ones get
   * fewer choices.
   */
  private dials(from: RoomSpec, rng: ReturnType<typeof createRng>): { archetype: Archetype; exits: number } {
    const t = this.profile.traits;
    const w: Record<Archetype, number> = { waiting_room: 1, corridor: 1, open_office: 1, hub: 1 };
    if (t.hesitation > 0.6) { w.corridor += 1.5; w.hub += 1; }
    if (t.curiosity > 0.6) { w.open_office += 1.5; w.hub += 0.5; }
    if (t.impulsivity > 0.6) { w.corridor += 1; w.waiting_room += 0.5; }
    const options = ARCHETYPES.filter((a) => a !== from.layout.archetype);
    const total = options.reduce((a, k) => a + w[k], 0);
    let r = rng() * total;
    let archetype = options[0]!;
    for (const k of options) if ((r -= w[k]) <= 0) { archetype = k; break; }
    let exits = 1 + Math.floor(rng() * 3);
    if (t.hesitation > 0.62) exits = 3;
    else if (t.impulsivity > 0.62) exits = Math.min(exits, 2);
    if (from.index + 1 >= this.last) exits = 1; // the last room has one way on
    return { archetype, exits };
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

  /** Works through queued plans one at a time, so the model never runs two room requests at once. */
  private async pump() {
    if (this.working || this.observing) return;
    const plan = this.plans.find((p) => p.status === 'queued');
    if (!plan) return;
    this.working = true;
    plan.status = 'generating';
    this.emitStatus();
    const rng = createRng(plan.seed);
    const rule = plan.index >= this.last ? undefined : chooseRule(this.profile, createRng(deriveSeed(plan.seed, 'pick-rule')), plan.index, this.current?.rule?.id as RuleId | undefined);
    let spec: RoomSpec;
    if (this.modelOff) {
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
    this.working = false;
    this.emitStatus();
    void this.pump();
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
    const layout: Layout = { ...plan.layout, doors: plan.layout.doors.map((d) => (labels.has(d.id) ? { ...d, label: labels.get(d.id)! } : { ...d, label: d.entrance ? plan.entranceLabel : d.label })) };
    return {
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
    };
  }

  private templateSpec(
    plan: Pick<Plan, 'index' | 'seed' | 'layout' | 'entranceLabel'>,
    rng: ReturnType<typeof createRng>,
    o: { first?: boolean; ambience?: string; rule?: Omit<RoomRule, 'line' | 'doneLine'> } = {},
  ): RoomSpec {
    const { layout } = plan;
    const t = this.data.templates;
    const assignments = templateAssignments(layout, this.data, rng, { index: plan.index, forceCenter: o.first ? 'button_pedestal' : undefined });
    const { props } = placeAssignments(layout, assignments, this.data);
    const spec: RoomSpec = {
      id: `room-${plan.index}-${plan.seed.toString(36)}`,
      index: plan.index,
      seed: plan.seed,
      layout: { ...layout, doors: layout.doors.map((d) => (d.entrance ? { ...d, label: plan.entranceLabel } : d)) },
      props,
      ambience: o.ambience ?? pick(rng, Object.keys(this.data.ambience)),
      narrator: {
        onEnter: o.first ? pick(rng, t.narratorFirst) : pick(rng, t.narratorEnter[layout.archetype] ?? t.narratorFirst),
        doors: Object.fromEntries(layout.doors.filter((d) => !d.entrance).map((d) => [d.id, pick(rng, t.narratorDoor)])),
      },
      source: 'template',
      title: o.first ? 'The waiting room' : layout.archetype.replace('_', ' '),
      provenance: o.first ? undefined : { behaviour: this.behaviourLog(), profile: this.profile.readout(), story: this.story(), error: (plan as Partial<Plan>).error },
    };
    if (o.rule) {
      const exits = layout.doors.filter((d) => !d.entrance);
      const params = o.rule.id === 'narrator_suggests' ? { ...o.rule.params, door: pick(rng, exits).id } : o.rule.params;
      const rule = { ...o.rule, params };
      spec.rule = { ...rule, ...templateRuleLines(rule, spec, this.data, rng) } as RuleSpec;
    }
    return spec;
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
