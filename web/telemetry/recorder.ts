import type { CoreMessage, Dossier, GameEvent, ProfileSnapshot, TraitName } from '../../core/protocol';
import type { RoomSpec } from '../../core/room/types';
import type { TelemetryEvent, Trait, TraitValue } from './telemetry';

/** What the player did with something they aimed at, at the moment they did it (before any animation). */
export interface Act {
  kind: 'inspect' | 'button' | 'door' | 'locked' | 'anomaly';
  id: string;
  /** For doors: whether it was locked when tried. */
  locked?: boolean;
}

export interface RecorderDeps {
  log(e: TelemetryEvent): void;
  end(profile: unknown, predictions: unknown): void;
  /** Wall clock in ms. */
  now(): number;
  /** Whether a prop recipe can be inspected (buttons are pressed, not inspected). */
  inspectable(recipe: string): boolean;
}

interface RoomState {
  spec: RoomSpec;
  enteredAt: number;
  /** When the exits became usable: entry, or the moment a lock rule opened them. */
  optionsAt: number;
  inspected: Set<string>;
  interactions: number;
  pressed: number;
  timer?: { startedAt: number; seconds: number; expired: boolean };
  /** The narrator has made its recommendation in this room. */
  narratorAt?: number;
  lockTaskAt?: number;
  lockTaskDone?: boolean;
  /** Lift lobby: the narrator has hinted that the lift isn't coming. */
  liftHinted?: boolean;
  dark: boolean;
  left: boolean;
}

/**
 * Turns what the adapter sees (events it sends core, messages core sends
 * back, and clicks) into raw telemetry rows. It only listens: it never
 * changes the game. Each choice carries the trait it measures (see tagDoor).
 */
export class Recorder {
  private room?: RoomState;
  private specs = new Map<string, RoomSpec>();
  private profile?: ProfileSnapshot;

  constructor(private deps: RecorderDeps) {}

  /** An event the adapter sent to core. */
  event(e: GameEvent) {
    const r = this.room;
    switch (e.type) {
      case 'run_started':
        this.log({ type: 'run_start', meta: { seed: e.seed } });
        break;
      case 'room_entered': {
        const spec = this.specs.get(e.roomId);
        if (!spec) return;
        const now = this.deps.now();
        this.room = { spec, enteredAt: now, optionsAt: now, inspected: new Set(), interactions: 0, pressed: 0, dark: false, left: false };
        this.log({
          type: 'room_enter',
          meta: {
            archetype: spec.layout.archetype,
            ambience: spec.ambience,
            source: spec.source,
            rule: spec.rule?.id ?? null,
            exits: spec.layout.doors.filter((d) => !d.entrance).length,
            inspectable: this.inspectableIds(spec).length,
          },
        });
        if (this.isButtonRoom(spec)) this.log({ type: 'task_start', choice: 'press_button', meta: { task: 'press_button' } });
        if (spec.gambleResult) this.log({ type: 'gamble_result', choice: spec.gambleResult, meta: { outcome: spec.gambleResult } });
        if (spec.rule?.id === 'gamble') {
          const g = spec.rule.params;
          this.log({ type: 'gamble_offer', meta: { safe: g.safe, risky: g.risky, timed: Number(g.seconds) > 0, seconds: Number(g.seconds) || null } });
        }
        break;
      }
      case 'inspected':
        if (!r || e.roomId !== r.spec.id) return;
        r.interactions++;
        r.inspected.add(e.objectId);
        this.log({ type: 'interact', choice: e.objectId, meta: { action: 'inspect', recipe: this.recipe(e.objectId), nth: r.interactions } });
        break;
      case 'pressed': {
        if (!r || e.roomId !== r.spec.id) return;
        r.interactions++;
        r.pressed++;
        this.log({ type: 'interact', choice: e.objectId, meta: { action: 'press', recipe: this.recipe(e.objectId), nth: r.interactions, press: r.pressed } });
        if (r.pressed === 1 && this.isButtonRoom(r.spec)) {
          const latency = this.deps.now() - r.optionsAt;
          // Pressing the button the room plainly wants pressed is doing as one is told.
          this.log({ type: 'choice', choice: 'press_button', trait: 'social', trait_value: 'follow', latency_ms: latency, meta: { kind: 'button' } });
          this.log({ type: 'task_done', choice: 'press_button', meta: { task: 'press_button', duration_ms: Math.round(latency) } });
        }
        break;
      }
      case 'looked_at':
        if (r && e.roomId === r.spec.id) this.log({ type: 'look', choice: e.objectId, meta: { seconds: e.seconds, recipe: this.recipe(e.objectId) } });
        break;
      case 'door_hovered':
        if (r && e.roomId === r.spec.id) this.log({ type: 'door_hover', choice: e.doorId, meta: { seconds: e.seconds, label: this.label(e.doorId) } });
        break;
      case 'idle':
        if (r && e.roomId === r.spec.id) this.log({ type: 'idle', meta: { seconds: e.seconds } });
        break;
      case 'door_tried':
        if (r && e.roomId === r.spec.id) this.log({ type: 'door_tried', choice: e.doorId, meta: { label: this.label(e.doorId) } });
        break;
    }
  }

  /** A click or key press on something, as it happens. */
  act(a: Act) {
    const r = this.room;
    if (!r || r.left) return;
    if (a.kind === 'locked') {
      // The entrance never opens; trying it is the only way to try going back.
      this.log({ type: 'backtrack_attempt', choice: a.id, meta: { label: this.label(a.id) } });
      return;
    }
    if (a.kind !== 'door' || a.locked) return;
    const now = this.deps.now();
    const spec = r.spec;
    if (this.isButtonRoom(spec) && r.pressed === 0) {
      this.log({ type: 'choice', choice: 'ignore_button', trait: 'social', trait_value: 'independent', latency_ms: now - r.optionsAt, meta: { kind: 'button' } });
      this.log({ type: 'task_skipped', choice: 'press_button', meta: { task: 'press_button', duration_ms: Math.round(now - r.enteredAt), reason: 'left_without_pressing' } });
    }
    const gamble = spec.rule?.id === 'gamble' ? spec.rule.params : undefined;
    if (r.timer && !r.timer.expired && !gamble) this.log({ type: 'task_done', choice: 'beat_timer', meta: { task: 'beat_timer', duration_ms: Math.round(now - r.timer.startedAt), seconds: r.timer.seconds } });
    const tag = this.tagDoor(r, a.id);
    const exits = spec.layout.doors.filter((d) => !d.entrance);
    this.log({
      type: 'choice',
      choice: a.id,
      trait: tag?.trait ?? null,
      trait_value: tag?.value ?? null,
      latency_ms: now - r.optionsAt,
      meta: {
        kind: 'door',
        label: this.label(a.id),
        options: exits.map((d) => d.id),
        option_labels: exits.map((d) => d.label),
        rule: spec.rule?.id ?? null,
        suggested: spec.rule?.id === 'narrator_suggests' ? spec.rule.params.door : undefined,
        narrator_lie: spec.rule?.id === 'narrator_suggests' ? Number(spec.rule.params.lie) === 1 : undefined,
        timer_left_s: r.timer && !r.timer.expired ? Math.max(0, r.timer.seconds - (now - r.timer.startedAt) / 1000) : undefined,
        // A gamble: which door was which, whether it was on a clock, and what actually happened.
        gamble: gamble && {
          safe: gamble.safe,
          risky: gamble.risky,
          timed: Number(gamble.seconds) > 0,
          seconds: Number(gamble.seconds) || null,
          expired: !!r.timer?.expired,
          outcome: a.id === gamble.risky ? gamble.outcome : 'certain',
        },
        inspected: r.inspected.size,
        inspectable: this.inspectableIds(spec).length,
        since_enter_ms: Math.round(now - r.enteredAt),
      },
    });
    this.log({ type: 'room_exit', choice: a.id, meta: { dwell_ms: Math.round(now - r.enteredAt), interactions: r.interactions, inspected: r.inspected.size } });
    r.left = true;
  }

  /** A message core sent the adapter. */
  message(m: CoreMessage) {
    const r = this.room;
    switch (m.type) {
      case 'load_room':
      case 'corridor_ready':
        this.specs.set(m.spec.id, m.spec);
        break;
      case 'task_result':
        // An office task finished: what it measured (its full event slice stays in core).
        this.log({ type: 'task_result', choice: m.result.task, meta: { metrics: m.result.metrics, notes: m.result.notes, params: m.result.params } });
        break;
      case 'profile':
        this.profile = m.profile;
        break;
      case 'narrator_line':
        if (m.final && r && !r.left && r.spec.rule?.id === 'narrator_suggests' && m.text === r.spec.rule.line && r.narratorAt === undefined) {
          r.narratorAt = this.deps.now();
          this.log({ type: 'pressure_start', meta: { source: 'narrator', suggested: r.spec.rule.params.door } });
        }
        if (m.final && r && !r.left && r.spec.rule?.id === 'lift_wait' && m.text === r.spec.rule.doneLine && !r.liftHinted) {
          r.liftHinted = true;
          this.log({ type: 'hint', choice: 'lift_hint', meta: { rule: 'lift_wait' } });
        }
        break;
      case 'rule_effect': {
        if (!r || r.left) return;
        const e = m.effect;
        const now = this.deps.now();
        const gamble = r.spec.rule?.id === 'gamble';
        if (e.kind === 'timer' && e.seconds !== null) {
          r.timer = { startedAt: now, seconds: e.seconds, expired: false };
          this.log({ type: 'pressure_start', meta: { source: 'timer', seconds: e.seconds, gamble } });
          if (!gamble) this.log({ type: 'task_start', choice: 'beat_timer', meta: { task: 'beat_timer', seconds: e.seconds } });
        } else if (e.kind === 'timer' && r.timer && !r.timer.expired && gamble) {
          // The timed gamble ran out: the 50/50 door is now locked.
          r.timer.expired = true;
          this.log({ type: 'gamble_expired', meta: { seconds: r.timer.seconds } });
          this.log({ type: 'pressure_end', meta: { source: 'timer', gamble } });
        } else if (e.kind === 'timer' && r.timer && !r.timer.expired) {
          r.timer.expired = true;
          this.log({ type: 'task_skipped', choice: 'beat_timer', meta: { task: 'beat_timer', duration_ms: Math.round(now - r.timer.startedAt), seconds: r.timer.seconds, reason: 'expired' } });
          this.log({ type: 'pressure_end', meta: { source: 'timer' } });
        } else if (e.kind === 'doors' && r.spec.rule?.id === 'inspect_to_unlock') {
          if (e.locked.length && r.lockTaskAt === undefined) {
            r.lockTaskAt = now;
            this.log({ type: 'task_start', choice: 'inspect_to_unlock', meta: { task: 'inspect_to_unlock', need: r.spec.rule.params.count } });
          } else if (!e.locked.length && r.lockTaskAt !== undefined && !r.lockTaskDone) {
            r.lockTaskDone = true;
            r.optionsAt = now;
            this.log({ type: 'task_done', choice: 'inspect_to_unlock', meta: { task: 'inspect_to_unlock', duration_ms: Math.round(now - r.lockTaskAt) } });
          }
        } else if (e.kind === 'lights') {
          r.dark = e.level < 1;
          this.log({ type: r.dark ? 'lights_dim' : 'lights_up', meta: { level: e.level } });
        }
        break;
      }
      case 'run_ended':
        this.log({ type: 'run_end', meta: { seconds: m.dossier.seconds, rooms: m.dossier.rooms.length } });
        this.deps.end(sessionProfile(this.profile ?? { traits: m.dossier.traits, evidence: [] }, m.dossier), predictions(m.dossier));
        break;
    }
  }

  /**
   * The trait a door choice measures, from the room's rule:
   * - narrator_suggests: social, took the recommended door (follow) or not (independent);
   * - exit_timer: patience, left while the countdown ran (now) or after it ran out (wait);
   * - no rule / lights_dim_on_idle: exploration, inspected anything here first (explore) or nothing (skip);
   * - inspect_to_unlock: null, since inspecting was forced;
   * - gamble: risk, the 50/50 door (risky) or the certain one (safe).
   */
  private tagDoor(r: RoomState, doorId: string): { trait: Trait; value: TraitValue } | null {
    const rule = r.spec.rule;
    if (rule?.id === 'gamble') return { trait: 'risk', value: doorId === rule.params.risky ? 'risky' : 'safe' };
    if (rule?.id === 'narrator_suggests') {
      const suggested = String(rule.params.door ?? '');
      if (!suggested || !r.spec.layout.doors.some((d) => d.id === suggested)) return null;
      return { trait: 'social', value: doorId === suggested ? 'follow' : 'independent' };
    }
    if (rule?.id === 'exit_timer') return r.timer ? { trait: 'patience', value: r.timer.expired ? 'wait' : 'now' } : null;
    if (rule?.id === 'inspect_to_unlock') return null;
    if (rule?.id === 'lift_wait') return { trait: 'patience', value: r.liftHinted ? 'wait' : 'now' };
    if (!this.inspectableIds(r.spec).length) return null;
    return { trait: 'exploration', value: r.inspected.size > 0 ? 'explore' : 'skip' };
  }

  private log(e: TelemetryEvent) {
    const r = this.room;
    const sources = r && !r.left ? [r.timer && !r.timer.expired ? 'timer' : '', r.narratorAt !== undefined ? 'narrator' : ''].filter(Boolean) : [];
    this.deps.log({
      ...e,
      room: e.room ?? r?.spec.id ?? null,
      meta: { room_index: r?.spec.index ?? null, pressure: sources.length > 0, pressure_source: sources, dark: r?.dark ?? false, ...e.meta },
    });
  }

  private isButtonRoom(spec: RoomSpec) {
    return spec.props.some((p) => p.recipe === 'button_pedestal');
  }
  private inspectableIds(spec: RoomSpec) {
    return spec.props.filter((p) => this.deps.inspectable(p.recipe)).map((p) => p.id);
  }
  private recipe(objectId: string) {
    return this.room?.spec.props.find((p) => p.id === objectId)?.recipe ?? null;
  }
  private label(doorId: string) {
    return this.room?.spec.layout.doors.find((d) => d.id === doorId)?.label ?? null;
  }
}

/**
 * The session's profile column: the hidden profile with its evidence, plus the
 * said/did comparison (self-ratings next to measured behaviour, 1–5), the
 * measured scores, the gambles and any resolved contradictions.
 */
function sessionProfile(p: ProfileSnapshot, d: Dossier) {
  return {
    ...p,
    said_did: d.saidDid ?? null,
    measured: d.measured ?? null,
    gambles: d.gambles ?? [],
    patterns: d.patterns ?? [],
  };
}

/** What the game concluded about the player, as shown on the dossier. */
function predictions(d: Dossier) {
  const label = (v: number) => (v >= 0.62 ? 'high' : v <= 0.38 ? 'low' : 'neutral');
  // Traits caught in a contradiction are shown as one pattern, not two labels.
  const mixed = new Set((d.patterns ?? []).flatMap((p) => p.traits));
  return {
    verdict: d.verdict,
    verdict_source: d.verdictSource,
    traits: d.traits,
    labels: Object.fromEntries(Object.entries(d.traits).map(([k, v]) => [k, mixed.has(k as TraitName) ? 'mixed' : label(v)])) as Record<TraitName, string>,
    patterns: (d.patterns ?? []).map((p) => p.sentence),
    said_did_headline: d.saidDid?.headline ?? null,
    seconds: d.seconds,
    rooms: d.rooms.map((r) => ({ index: r.index, archetype: r.archetype, rule: r.rule ?? null, source: r.source })),
    stats: d.stats,
  };
}
