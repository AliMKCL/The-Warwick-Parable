import type { GameEvent } from '../../protocol';
import { createRng, deriveSeed, type Rng } from '../../util/random';
import type { TestHandle, TestKind } from '../types';
import type { ModuleCtx, OfficeTaskModule, TaskParams } from './module';

/** The room each office task builds (its Builder archetype), for the scheduler and decoration. */
export const OFFICE_ROOMS: Record<string, string> = {
  balloons: 'party_room',
  coffee: 'break_room',
  canteen: 'canteen',
  renumbered: 'junction',
  pitch: 'boardroom',
  loan: 'coffee_nook',
  lockdown: 'meeting_suite',
};

/**
 * Runs one office task module (core/testrooms/office/*.ts, from PR #6) as a
 * test in the run's pool. The module stays as written: this gives it its
 * context (log, lines, questions, zones, its own seeded randomness), feeds it
 * the player's events, and when the player leaves, scores it, nudges the
 * profile and reports the result.
 *
 * Its room is a set piece: the module's own layout, with its labels fixed.
 */
export function officeTest(m: OfficeTaskModule): TestKind {
  return {
    id: m.id,
    candidates: [{ archetype: OFFICE_ROOMS[m.id] ?? m.id }],
    maxPerRun: 1,
    setPiece: true,
    room({ seed, rng, data }) {
      const defaults = m.defaults(seed);
      const { layout, extra } = m.layout(defaults, rng, data);
      // The task depends on its door labels (the renumbered floor's numbers, the exit signs): the model may not rename them.
      const fixed = { ...layout, doors: layout.doors.map((d) => (d.entrance ? d : { ...d, fixedLabel: true })) };
      return { layout: fixed, params: plain({ ...defaults, ...extra }) };
    },
    params: () => ({}),
    describe: (_p, data) => {
      const t = data.tasks.office[m.id];
      return `This room stages a scripted task: ${t?.brief ?? t?.title ?? m.id} Its fixtures, their labels and every line about the task are fixed and spoken separately: don't explain the task or contradict it. Write the room around it. "rule_line" is a short dry remark about the room; leave "rule_done_line" empty.`;
    },
    templateLines: () => ({ line: '', doneLine: '' }),
    start(h, t) {
      run(h).begin(t);
    },
    onEvent(h, e) {
      run(h).event(e);
    },
  };

  /** The module's live state for this room, kept on the test's handle. */
  function run(h: TestHandle): OfficeRun {
    return ((h.state.office as OfficeRun | undefined) ??= new OfficeRun(m, h));
  }
}

/** Rule params are plain JSON: booleans become 1 / 0. */
function plain(p: TaskParams): Record<string, number | string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'boolean' ? Number(v) : v]));
}

/** One occurrence of an office task: what the module's ModuleCtx reads and writes. */
class OfficeRun {
  private ctx: ModuleCtx;
  private at = 0;
  private t0 = 0;
  private started = false;
  private finished = false;
  private last?: { t: number; x: number; z: number };
  private inside = new Set<string>();
  private rngs = new Map<string, Rng>();

  constructor(private m: OfficeTaskModule, private h: TestHandle) {
    const id = m.id;
    const self = this;
    const text = h.data.tasks.office[id] ?? { title: id, brief: '', lines: {} };
    this.ctx = {
      room: h.room,
      get p() { return h.rule.params; },
      data: h.data,
      state: {},
      text,
      now: () => self.at,
      t0: () => self.t0,
      log: (type, data = {}) => self.log(type, { ...data, version: 'office' }),
      say: (key, line) => {
        const said = line ?? text.lines[key] ?? '';
        if (!said) return;
        self.log('narrator_line', { line: key, version: 'office' });
        h.say(said);
      },
      emit: (effect) => h.emit(effect),
      ask: (a) => {
        h.emit({ kind: 'ask', ask: a });
        self.log('prompt_shown', { prompt: a.id, mode: a.mode, ...(a.mode === 'choice' ? { options: a.options } : {}), version: 'office' });
      },
      rng: (label) => {
        let r = self.rngs.get(label);
        if (!r) self.rngs.set(label, (r = createRng(deriveSeed(h.room.seed, `${id}:${label}`))));
        return r;
      },
      player: () => (self.last ? { x: self.last.x, z: self.last.z } : undefined),
      inZone: (zone) => self.inside.has(zone),
      exits: () => h.exits,
    };
  }

  begin(t: number) {
    if (this.started) return;
    this.started = true;
    this.t0 = this.at = t;
    this.log('task_start', { room: this.h.room.index, params: this.h.rule.params });
    this.m.begin(this.ctx);
  }

  event(e: GameEvent) {
    if (!this.started || this.finished) return;
    if ('roomId' in e && e.roomId !== this.h.room.id) return;
    this.at = Math.max(this.at, e.t);
    this.m.tick?.(this.ctx, this.at);
    switch (e.type) {
      case 'move':
        this.move(e.x, e.z, e.t);
        break;
      case 'input':
        this.log('input', { key: e.key, ...(e.target ? { target: e.target } : {}) });
        break;
      case 'answer':
        this.log('answer', { ask: e.askId, value: e.value, seconds: e.seconds });
        this.m.onEvent?.(this.ctx, e);
        break;
      case 'inspected':
        this.log('interact', { object: e.objectId, action: 'inspect' });
        this.m.onEvent?.(this.ctx, e);
        break;
      case 'door_tried':
        this.log('interact', { object: e.doorId, action: 'door_tried' });
        this.m.onEvent?.(this.ctx, e);
        break;
      case 'pressed':
        this.m.onEvent?.(this.ctx, e);
        break;
      case 'door_chosen':
        this.m.onLeave?.(this.ctx, e.doorId);
        this.finish('left');
        break;
    }
  }

  /** The player left: score the task, nudge the profile, report the result. */
  private finish(outcome: string) {
    if (this.finished) return;
    this.finished = true;
    this.h.emit({ kind: 'ask_close', id: '*' });
    this.h.emit({ kind: 'status', text: null });
    this.log('task_end', { outcome });
    const events = this.h.log.slice(this.m.id);
    const score = this.m.score(events, { params: this.h.rule.params, baseline: this.h.baseline(), all: this.h.log.events });
    this.m.profile?.(score.metrics, (trait, delta, reason) => this.h.profile.adjust(trait, delta, reason, this.h.room, this.at));
    this.h.report({
      task: this.m.id,
      room: this.h.room.index,
      title: this.ctx.text.title,
      params: this.h.rule.params,
      metrics: score.metrics,
      notes: score.notes,
    });
  }

  private move(x: number, z: number, t: number) {
    const prev = this.last;
    const dt = prev ? t - prev.t : 0;
    const vx = prev && dt > 0 ? (x - prev.x) / dt : 0;
    const vz = prev && dt > 0 ? (z - prev.z) / dt : 0;
    this.last = { t, x, z };
    this.log('move', { x: r3(x), z: r3(z), vx: r3(vx), vz: r3(vz) });
    for (const zone of this.h.room.layout.zones ?? []) {
      const inside = Math.hypot(x - zone.x, z - zone.z) <= zone.r;
      if (inside === this.inside.has(zone.id)) continue;
      if (inside) this.inside.add(zone.id);
      else this.inside.delete(zone.id);
      this.log(inside ? 'zone_enter' : 'zone_exit', { zone: zone.id });
      this.m.onZone?.(this.ctx, zone.id, inside);
    }
  }

  private log(type: string, data: Record<string, unknown> = {}) {
    this.h.log.emit(this.m.id, type, data, this.at);
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
