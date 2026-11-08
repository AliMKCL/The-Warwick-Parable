import type { Profile } from '../profile/profile';
import type { GameEvent, RuleEffect } from '../protocol';
import { LIFT } from '../room/layouts';
import type { GameData, Layout, RoomSpec } from '../room/types';
import { pick, randInt, type Rng } from '../util/random';

export type RuleId = 'lights_dim_on_idle' | 'inspect_to_unlock' | 'exit_timer' | 'narrator_suggests' | 'gamble' | 'lift_wait';

/** Labels drawn on a gamble room's two doors, so the stakes are visible as well as spoken. */
export const GAMBLE_LABELS = { safe: 'CERTAIN', risky: '50/50' } as const;
/** Seconds on the clock in the timed gamble. */
export const GAMBLE_SECONDS = 15;

export interface RoomRule {
  id: RuleId;
  /** lights: idleSeconds · unlock: count · timer: seconds · suggests: door, lie (1/0)
   *  gamble: safe, risky (door ids), seconds (0 = no clock), outcome ('shortcut' | 'setback', decided in advance by seed),
   *          stakes (the line that spells them out)
   *  lift: door (the maintenance door), hintSeconds */
  params: Record<string, number | string>;
  /** Spoken when the rule starts or first triggers. */
  line: string;
  /** Spoken when it resolves: doors unlock, the timer runs out. */
  doneLine: string;
}

/** What the model is told about each rule, so its text fits the mechanic. */
export function describeRule(r: Pick<RoomRule, 'id' | 'params'>): string {
  switch (r.id) {
    case 'lights_dim_on_idle':
      return `Lights dim when the player stands still for ${r.params.idleSeconds} s and come back when they move. "rule_line" is said as the lights go down.`;
    case 'inspect_to_unlock':
      return `Every exit is locked until the player inspects ${r.params.count} things. "rule_line" is said on entry and hints at this; "rule_done_line" is said when the doors unlock. Make the inspect texts worth reading.`;
    case 'exit_timer':
      return `A countdown of ${r.params.seconds} s starts on entry. When it ends, all exits but one lock. "rule_line" announces the countdown; "rule_done_line" is said when it runs out.`;
    case 'gamble':
      return `This room is a gamble between its two exits. Door ${r.params.safe} is CERTAIN: the next room, as planned. Door ${r.params.risky} is a 50/50: it either saves time (skips the next room's task) or adds a detour room.${Number(r.params.seconds) ? ` The player has ${r.params.seconds} s before the 50/50 door locks.` : ''} The narrator states these stakes separately, so "narrator_enter" should only set the scene, and "rule_line" should be a short dry remark about luck. Do not contradict the stakes.`;
    case 'lift_wait':
      return `This is a lift lobby. A lift with a floor indicator stands opposite the entrance, with a call button beside it. The lift never arrives: the indicator creeps down and stalls a floor or two away. The only way on is a plain door labelled MAINTENANCE in a side wall (${r.params.door}); its label is fixed. "rule_line" is said on entry and assures the player the lift is coming. "rule_done_line" is said if they are still waiting after ${r.params.hintSeconds} s, and hints at another way without naming the door. Do not mention the maintenance door anywhere else, but you may write on the walls about the lift.`;
    case 'narrator_suggests':
      return `The narrator recommends one exit: set "suggest_door" and use "rule_line" to recommend it.${Number(r.params.lie) ? ' The narrator is lying: the recommendation is self-serving, and a later room will reveal this.' : ' The advice is sincere.'}`;
  }
}

/**
 * A gamble between a room's two exits. The first exit is the certain one.
 * The coin is tossed now, from the seed, so the 50/50 is real and replays the same.
 */
export function gambleRule(exits: string[], rng: Rng, timed: boolean): Omit<RoomRule, 'line' | 'doneLine'> {
  return {
    id: 'gamble',
    params: { safe: exits[0]!, risky: exits[1] ?? exits[0]!, seconds: timed ? GAMBLE_SECONDS : 0, outcome: rng() < 0.5 ? 'shortcut' : 'setback' },
  };
}

/**
 * Picks a rule that pushes against the player's strongest tendencies. Room 0 has its own test (the button).
 * `requireTask` (the room behind a gamble) never returns "no rule", so a shortcut always has a task to skip.
 */
export function chooseRule(profile: Profile, rng: Rng, index: number, previous?: RuleId, requireTask = false): Omit<RoomRule, 'line' | 'doneLine'> | undefined {
  if (index === 0) return undefined;
  const t = profile.traits;
  const up = (v: number) => Math.max(0, v - 0.5);
  const weights: [RuleId | 'none', number][] = [
    ['exit_timer', 1 + 4 * up(t.hesitation)],
    ['inspect_to_unlock', 1 + 4 * up(t.impulsivity) + 2 * up(1 - t.curiosity)],
    ['lights_dim_on_idle', 0.8 + 3 * up(t.hesitation) + 1.5 * up(t.curiosity)],
    ['narrator_suggests', 1 + 3 * Math.abs(t.compliance - 0.5)],
    ['none', index === 1 ? 0.6 : 0.35],
  ];
  const usable = weights.filter(([id]) => id !== previous && !(requireTask && id === 'none'));
  const total = usable.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  let id: RuleId | 'none' = 'none';
  for (const [k, w] of usable) {
    if ((r -= w) <= 0) { id = k; break; }
  }
  switch (id) {
    case 'none':
    case 'gamble': return undefined;
    case 'lights_dim_on_idle': return { id, params: { idleSeconds: randInt(rng, 4, 7) } };
    case 'inspect_to_unlock': return { id, params: { count: rng() < 0.5 ? 2 : 3 } };
    case 'exit_timer': return { id, params: { seconds: randInt(rng, 25, 40) } };
    case 'narrator_suggests': return { id, params: { door: '', lie: rng() < 0.4 + 0.4 * up(t.compliance) ? 1 : 0 } };
  }
}

/** The lift lobby always runs the lift rule (and never any other). */
export function liftRule(layout: Layout, rng: Rng): Omit<RoomRule, 'line' | 'doneLine'> {
  const door = layout.doors.find((d) => !d.entrance)?.id ?? 'd1';
  return { id: 'lift_wait', params: { door, hintSeconds: randInt(rng, 45, 70) } };
}

/** Template lines when the model is unavailable. */
export function templateRuleLines(rule: Omit<RoomRule, 'line' | 'doneLine'>, room: RoomSpec, data: GameData, rng: Rng): Pick<RoomRule, 'line' | 'doneLine'> {
  const lines = data.templates.rules[rule.id];
  const door = room.layout.doors.find((d) => d.id === rule.params.door)?.label ?? '';
  const fill = (s: string) => s.replaceAll('{door}', door).replaceAll('{count}', String(rule.params.count)).replaceAll('{seconds}', String(rule.params.seconds));
  if (rule.id === 'gamble') {
    // The stakes are always spelled out from templates, even in model-written rooms: the player must know it is a gamble.
    const line = Number(rule.params.seconds) ? pick(rng, data.templates.gamble.timedLine) : pick(rng, lines.line);
    return { line: fill(line), doneLine: fill(pick(rng, lines.done)) };
  }
  return { line: fill(pick(rng, lines.line)), doneLine: fill(pick(rng, lines.done)) };
}

export interface RuleContext {
  room: RoomSpec;
  profile: Profile;
  emit(effect: RuleEffect): void;
  say(text: string): void;
  rng: Rng;
  data: GameData;
}

const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

/** A rule running in the current room: reacts to events and changes the world through effects. */
export class RuleRuntime {
  private timer: unknown;
  private floorTimer: unknown;
  private state: Record<string, unknown> = {};
  private stopped = false;

  constructor(readonly rule: RoomRule, private ctx: RuleContext) {}

  /** `history` is the run's event log so far, so a rule can pick up the player's current state. */
  start(t: number, history: GameEvent[] = []) {
    const { rule, ctx } = this;
    const exits = ctx.room.layout.doors.filter((d) => !d.entrance).map((d) => d.id);
    switch (rule.id) {
      case 'inspect_to_unlock': {
        const inspectable = ctx.room.props.filter((p) => ctx.data.props.find((r) => r.id === p.recipe)?.inspectable).length + (ctx.room.anomaly ? 1 : 0);
        this.state.need = Math.min(Number(rule.params.count), inspectable);
        this.state.seen = new Set(history.flatMap((e) => {
          if (!('roomId' in e) || e.roomId !== ctx.room.id) return [];
          if (e.type === 'inspected') return [e.objectId];
          if (e.type === 'anomaly_action' && e.action === 'use' && e.anomalyId === ctx.room.anomaly?.id) return [`anomaly:${e.anomalyId}`];
          return [];
        }));
        this.state.open = (this.state.seen as Set<string>).size >= Number(this.state.need);
        if (Number(this.state.need) > 0 && !this.state.open) {
          ctx.emit({ kind: 'doors', locked: exits });
          ctx.say(rule.line);
        }
        break;
      }
      case 'exit_timer': {
        const seconds = Number(rule.params.seconds);
        ctx.emit({ kind: 'timer', seconds, label: 'Doors close in' });
        ctx.say(rule.line);
        this.state.startedAt = t;
        this.timer = timers.setTimeout(() => this.expire(), seconds * 1000);
        break;
      }
      case 'narrator_suggests':
        ctx.say(rule.line);
        break;
      case 'gamble': {
        // The stakes, always from templates; rule.line is the model's own remark and is not needed here.
        ctx.say(String(rule.params.stakes || rule.line));
        const seconds = Number(rule.params.seconds);
        if (seconds > 0) {
          ctx.emit({ kind: 'timer', seconds, label: '50/50 closes in' });
          this.state.startedAt = t;
          this.timer = timers.setTimeout(() => this.expireGamble(), seconds * 1000);
        }
        break;
      }
      case 'lift_wait': {
        ctx.say(rule.line);
        this.state.startedAt = t;
        this.state.presses = 0;
        // The indicator creeps down floor by floor, then hovers between the last two. It never arrives.
        let step = 0;
        const tick = () => {
          if (this.stopped) return;
          step++;
          const n = LIFT.floors.length;
          const text = step < n ? LIFT.floors[step]! : LIFT.floors[n - 1 - ((step - n + 1) % 2)]!;
          ctx.emit({ kind: 'display', prop: LIFT.doors, text });
          this.floorTimer = timers.setTimeout(tick, step < n - 1 ? 3500 : 5000);
        };
        this.floorTimer = timers.setTimeout(tick, 3500);
        this.timer = timers.setTimeout(() => this.liftHint(), Number(rule.params.hintSeconds) * 1000);
        break;
      }
      case 'lights_dim_on_idle': {
        // Already standing still when the rule starts? Treat it as stopping now.
        const last = [...history].reverse().find((e) => e.type === 'motion' && e.roomId === ctx.room.id);
        if (last?.type === 'motion' && !last.moving) this.onEvent({ type: 'motion', roomId: ctx.room.id, moving: false, t });
        break;
      }
    }
  }

  onEvent(e: GameEvent) {
    if (this.stopped) return;
    const { rule, ctx } = this;
    const room = ctx.room;
    switch (rule.id) {
      case 'lights_dim_on_idle':
        if (e.type === 'motion' && !e.moving) {
          timers.clearTimeout(this.timer);
          this.timer = timers.setTimeout(() => {
            this.state.dimmedAt = e.t + Number(rule.params.idleSeconds);
            ctx.emit({ kind: 'lights', level: 0.12, seconds: 4 });
            if (!this.state.said) { ctx.say(rule.line); this.state.said = true; }
          }, Number(rule.params.idleSeconds) * 1000);
        } else if (e.type === 'motion' && e.moving) {
          timers.clearTimeout(this.timer);
          if (this.state.dimmedAt !== undefined) {
            const dark = e.t - Number(this.state.dimmedAt);
            if (dark > 6) ctx.profile.adjust('hesitation', 0.1, `stayed still in the dark for ${Math.round(dark)} s`, room, e.t);
            else ctx.profile.adjust('compliance', 0.05, 'moved as soon as the lights dimmed', room, e.t);
            this.state.dimmedAt = undefined;
            ctx.emit({ kind: 'lights', level: 1, seconds: 0.8 });
          }
        }
        break;
      case 'inspect_to_unlock': {
        const seen = this.state.seen as Set<string>;
        if ((e.type === 'inspected' || (e.type === 'anomaly_action' && e.action === 'use' && e.anomalyId === room.anomaly?.id)) && !this.state.open) {
          seen.add(e.type === 'inspected' ? e.objectId : `anomaly:${e.anomalyId}`);
          if (seen.size >= Number(this.state.need)) {
            this.state.open = true;
            ctx.emit({ kind: 'doors', locked: [] });
            ctx.say(rule.doneLine);
          }
        } else if (e.type === 'door_tried' && !this.state.open) {
          if (!this.state.tried) ctx.profile.adjust('impulsivity', 0.08, 'tried a locked door before looking around', room, e.t);
          this.state.tried = true;
          ctx.say(pick(ctx.rng, ctx.data.templates.rules.inspect_to_unlock.tried ?? ['Not yet.']));
        }
        break;
      }
      case 'exit_timer':
        if (e.type === 'door_chosen' && !this.state.expired) {
          const used = e.t - Number(this.state.startedAt ?? e.t);
          if (used < Number(rule.params.seconds) / 3) ctx.profile.adjust('impulsivity', 0.07, `left ${Math.round(used)} s into the countdown`, room, e.t);
        } else if (e.type === 'door_hovered') {
          this.state.hovered = { ...(this.state.hovered as object), [e.doorId]: true };
        }
        break;
      case 'gamble':
        if (e.type === 'door_chosen') {
          timers.clearTimeout(this.timer);
          if (e.doorId === rule.params.risky) ctx.profile.adjust('impulsivity', 0.08, 'took the 50/50 door', room, e.t);
          else ctx.profile.adjust('impulsivity', -0.05, this.state.expired ? 'let the gamble run out and took the certain door' : 'chose the certain door over the 50/50', room, e.t);
        }
        break;
      case 'lift_wait':
        if (e.type === 'pressed' && e.objectId === LIFT.call) {
          const n = Number(this.state.presses) + 1;
          this.state.presses = n;
          if (n === 3) ctx.say(pick(ctx.rng, ctx.data.templates.rules.lift_wait.tried ?? ['It heard you the first time.']));
          if (n === 5) ctx.profile.adjust('impulsivity', 0.12, 'kept pressing the button for a lift that never came', room, e.t);
        } else if (e.type === 'door_chosen' && e.doorId === rule.params.door) {
          const waited = e.t - Number(this.state.startedAt ?? e.t);
          if (!this.state.hinted) ctx.profile.adjust('hesitation', -0.08, `gave up on the lift and found the maintenance door after ${Math.round(waited)} s`, room, e.t);
          else ctx.profile.adjust('compliance', 0.05, 'took the other way once the narrator hinted at it', room, e.t);
        }
        break;
      case 'narrator_suggests':
        if (e.type === 'door_chosen') {
          const followed = e.doorId === rule.params.door;
          const lie = Number(rule.params.lie) === 1;
          ctx.profile.adjust('compliance', followed ? 0.18 : -0.18,
            followed ? `took the door the narrator recommended${lie ? ' (the narrator was lying)' : ''}` : `ignored the narrator's recommendation${lie ? ' (it was a lie)' : ''}`,
            room, e.t);
        }
        break;
    }
  }

  borrowTime(t: number, seconds: number): boolean {
    if (this.stopped || this.rule.id !== 'exit_timer' || this.state.expired || this.state.borrowed || this.state.startedAt === undefined) return false;
    const remaining = Number(this.state.startedAt) + Number(this.rule.params.seconds) - t;
    if (remaining <= 0) return false;
    this.state.borrowed = true;
    this.state.borrowedSeconds = seconds;
    timers.clearTimeout(this.timer);
    this.timer = timers.setTimeout(() => this.expire(), (remaining + seconds) * 1000);
    this.ctx.emit({ kind: 'timer', seconds: remaining + seconds, label: 'Doors close in' });
    return true;
  }

  private liftHint() {
    if (this.stopped || this.state.hinted) return;
    const { ctx } = this;
    this.state.hinted = true;
    ctx.profile.adjust('hesitation', 0.12, `waited ${this.rule.params.hintSeconds} s for a lift that never came`, ctx.room, Number(this.state.startedAt ?? 0) + Number(this.rule.params.hintSeconds));
    ctx.say(this.rule.doneLine);
  }

  private expire() {
    if (this.stopped) return;
    const { ctx } = this;
    this.state.expired = true;
    const exits = ctx.room.layout.doors.filter((d) => !d.entrance).map((d) => d.id);
    const hovered = (this.state.hovered ?? {}) as Record<string, boolean>;
    // Keep open the door they paid least attention to.
    const keep = exits.find((id) => !hovered[id]) ?? exits[0]!;
    ctx.emit({ kind: 'timer', seconds: null, label: '' });
    ctx.emit({ kind: 'doors', locked: exits.filter((id) => id !== keep) });
    ctx.profile.adjust('hesitation', 0.14, 'let the countdown run out', ctx.room, Number(this.state.startedAt ?? 0) + Number(this.rule.params.seconds) + Number(this.state.borrowedSeconds ?? 0));
    ctx.say(this.rule.doneLine);
  }

  /** The timed gamble ran out: the 50/50 door locks, only the certain one is left. */
  private expireGamble() {
    if (this.stopped) return;
    this.state.expired = true;
    this.ctx.emit({ kind: 'timer', seconds: null, label: '' });
    this.ctx.emit({ kind: 'doors', locked: [String(this.rule.params.risky)] });
    this.ctx.say(this.rule.doneLine);
  }

  stop() {
    this.stopped = true;
    timers.clearTimeout(this.timer);
    timers.clearTimeout(this.floorTimer);
  }
}
