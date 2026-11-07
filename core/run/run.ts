import { describeVisit } from '../director/summary';
import { generateRoomContent } from '../director/content';
import { LlmError, type LlmClient } from '../llm/client';
import { OPPOSITE } from '../room/geometry';
import { ARCHETYPES, generateLayout, type Archetype } from '../room/layouts';
import { placeAssignments } from '../room/place';
import { templateAssignments } from '../room/templates';
import type { Door, GameData, Layout, RoomSpec } from '../room/types';
import { createRng, deriveSeed, pick } from '../util/random';
import type { GameEvent } from '../protocol';

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

  constructor(
    readonly seed: number,
    private readonly data: GameData,
    private readonly opts: RunOptions = {},
  ) {
    if (!opts.llm) this.modelOff = true;
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

  /** What the player did in a room, as sentences. */
  describe(room: RoomSpec): string[] {
    return describeVisit(room, this.events, this.data);
  }

  /** One line per earlier room, for the story memory. */
  story(): string[] {
    return this.rooms.map((r) => `Room ${r.index} "${r.title}"${r.fact ? `: ${r.fact}` : ''}`);
  }

  plansStatus() {
    return this.plans.map((p) => ({ door: p.doorId, status: p.status, ms: p.spec?.genMs, error: p.error }));
  }

  // ---------- internals ----------

  private enter(room: RoomSpec) {
    this.rooms.push(room);
    this.plans = room.layout.doors
      .filter((d) => !d.entrance)
      .map((d) => this.plan(room, d));
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
    const archetype = pick(rng, ARCHETYPES.filter((a) => a !== from.layout.archetype)) as Archetype;
    const layout = generateLayout({
      archetype,
      entranceSide: OPPOSITE[door.side],
      exits: 1 + Math.floor(rng() * 3),
      rng,
      doorLabels: this.data.templates.doorLabels,
    });
    let resolve!: (s: RoomSpec) => void;
    const done = new Promise<RoomSpec>((r) => (resolve = r));
    return { doorId: door.id, index, seed, layout, entranceLabel: door.label, status: 'queued', done, resolve };
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
    let spec: RoomSpec;
    if (this.modelOff) {
      spec = this.templateSpec(plan, rng);
    } else {
      spec = await this.modelSpec(plan, rng).catch((err: unknown) => {
        const e = err as LlmError;
        plan.error = e.message;
        if (e instanceof LlmError && e.kind === 'unreachable') this.modelOff = true;
        return this.templateSpec(plan, createRng(plan.seed));
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

  private async modelSpec(plan: Plan, rng: ReturnType<typeof createRng>): Promise<RoomSpec> {
    const Abort = (globalThis as unknown as { AbortController?: new () => { abort(): void; signal: unknown } }).AbortController;
    const controller = Abort ? new Abort() : undefined;
    plan.abort = controller;
    const started = this.now();
    const gen = await generateRoomContent(
      this.opts.llm!,
      {
        index: plan.index,
        layout: plan.layout,
        entranceLabel: plan.entranceLabel,
        story: this.story(),
        behaviour: this.behaviourLog(),
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
    };
  }

  private templateSpec(
    plan: Pick<Plan, 'index' | 'seed' | 'layout' | 'entranceLabel'>,
    rng: ReturnType<typeof createRng>,
    o: { first?: boolean; ambience?: string } = {},
  ): RoomSpec {
    const { layout } = plan;
    const t = this.data.templates;
    const assignments = templateAssignments(layout, this.data, rng, { index: plan.index, forceCenter: o.first ? 'button_pedestal' : undefined });
    const { props } = placeAssignments(layout, assignments, this.data);
    return {
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
