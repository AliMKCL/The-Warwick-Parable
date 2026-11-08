import type { Profile } from '../profile/profile';
import type { GameEvent, RuleEffect, TaskResult } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';
import { TESTS } from '../testrooms/registry';
import type { Baseline } from '../testrooms/office/metrics';
import type { TestHandle, TestLog } from '../testrooms/types';
import { pick, type Rng } from '../util/random';

export { GAMBLE_LABELS, GAMBLE_SECONDS } from '../testrooms/kinds/gamble';

/** A room's rule is the runtime side of its test (see core/testrooms). The id is the test's id. */
export type RuleId = string;

export interface RoomRule {
  id: RuleId;
  /** The test's settings, made by its `params` (see each file in core/testrooms/kinds). */
  params: Record<string, number | string>;
  /** Spoken when the rule starts or first triggers. */
  line: string;
  /** Spoken when it resolves: doors unlock, the timer runs out. */
  doneLine: string;
}

/** What the model is told about a room's rule, so its text fits the mechanic. */
export function describeRule(r: Pick<RoomRule, 'id' | 'params'>, data: GameData): string {
  return TESTS[r.id]?.describe(r.params, data) ?? '';
}

/** Template lines when the model is unavailable (a test can supply its own). */
export function templateRuleLines(rule: Omit<RoomRule, 'line' | 'doneLine'>, room: RoomSpec, data: GameData, rng: Rng): Pick<RoomRule, 'line' | 'doneLine'> {
  const own = TESTS[rule.id]?.templateLines;
  if (own) return own(rule.params, room, data, rng);
  const lines = data.templates.rules[rule.id] ?? { line: [''], done: [''] };
  const door = room.layout.doors.find((d) => d.id === rule.params.door)?.label ?? '';
  const fill = (s: string) => s.replaceAll('{door}', door).replaceAll('{count}', String(rule.params.count)).replaceAll('{seconds}', String(rule.params.seconds));
  return { line: fill(pick(rng, lines.line)), doneLine: fill(pick(rng, lines.done)) };
}

export interface RuleContext {
  room: RoomSpec;
  profile: Profile;
  emit(effect: RuleEffect): void;
  say(text: string): void;
  rng: Rng;
  data: GameData;
  /** The run's test log, results sink and baseline (optional: a test that doesn't score itself doesn't need them). */
  log?: TestLog;
  report?(result: TaskResult): void;
  baseline?(): Baseline | null;
}

/** A throwaway log, for rules run on their own (tests). */
export function testLog(): TestLog {
  const events: TestLog['events'] = [];
  return {
    events,
    emit: (task, type, data, t) => { events.push({ t: Math.round(t * 1000) / 1000, task, type, data }); },
    slice: (task) => events.filter((e) => e.task === task),
  };
}

const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

/**
 * The rule running in the current room: hands the room's events to its test
 * (core/testrooms/kinds) and owns the test's timers, so leaving the room stops
 * everything the test started.
 */
export class RuleRuntime {
  private timers = new Map<string, unknown>();
  private stopped = false;
  private handle: TestHandle;

  constructor(readonly rule: RoomRule, ctx: RuleContext) {
    const self = this;
    this.handle = {
      rule,
      room: ctx.room,
      profile: ctx.profile,
      data: ctx.data,
      rng: ctx.rng,
      state: {},
      exits: ctx.room.layout.doors.filter((d) => !d.entrance).map((d) => d.id),
      log: ctx.log ?? testLog(),
      report: (r) => ctx.report?.(r),
      baseline: () => ctx.baseline?.() ?? null,
      emit: (e) => { if (!self.stopped) ctx.emit(e); },
      say: (text) => { if (!self.stopped) ctx.say(text); },
      after: (name, seconds, fn) => {
        timers.clearTimeout(self.timers.get(name));
        self.timers.set(name, timers.setTimeout(() => { self.timers.delete(name); if (!self.stopped) fn(); }, seconds * 1000));
      },
      clear: (name) => { timers.clearTimeout(self.timers.get(name)); self.timers.delete(name); },
      get stopped() { return self.stopped; },
    };
  }

  /** `history` is the run's event log so far, so a rule can pick up the player's current state. */
  start(t: number, history: GameEvent[] = []) {
    TESTS[this.rule.id]?.start?.(this.handle, t, history);
  }

  onEvent(e: GameEvent) {
    if (this.stopped) return;
    TESTS[this.rule.id]?.onEvent?.(this.handle, e);
  }

  /** An anomaly asks for more time on a running clock. */
  borrowTime(t: number, seconds: number): boolean {
    if (this.stopped) return false;
    return TESTS[this.rule.id]?.borrowTime?.(this.handle, t, seconds) ?? false;
  }

  stop() {
    this.stopped = true;
    for (const id of this.timers.values()) timers.clearTimeout(id);
    this.timers.clear();
  }
}
