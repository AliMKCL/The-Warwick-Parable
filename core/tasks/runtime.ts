import type { Profile } from '../profile/profile';
import type { GameEvent, RuleEffect, TaskEvent, TaskResult } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';
import { createRng, deriveSeed, type Rng } from '../util/random';
import type { TaskLog } from './log';
import { type Baseline } from './metrics';
import { isOfficeModule, OFFICE_MODULES, type OfficeTaskId, type OfficeTaskModule } from './office';
import type { ModuleCtx } from './office/module';
import type { TaskId, TaskParams } from './params';
import { scoreAny, taskTitle } from './score';

export interface TaskContext {
  log: TaskLog;
  data: GameData;
  profile: Profile;
  emit(effect: RuleEffect): void;
  /** Say a fixed line; `lineId` comes back in a narrator_shown event when it appears on screen. */
  say(text: string, lineId: string): void;
  baseline(): Baseline | null;
}

/** Rough speaking time of a line, seconds. Narrator lines are timed so tasks can tell whether the player acted before one finished. */
export function lineSeconds(text: string): number {
  return Math.round((0.6 + text.length / 14) * 100) / 100;
}

/**
 * Runs one office task in the current room (or, for room 0, records the
 * baseline). It turns what the player does into the shared task log, drives
 * the task's scripted events from the run clock, and scores the task when the
 * player leaves. All timing comes from event times, never wall time, so
 * paused time is excluded and a session replays the same way.
 */
export class TaskRuntime {
  private started = false;
  private finished = false;
  private t0 = 0;
  private now = 0;
  private last?: { t: number; x: number; z: number };
  private inside = new Set<string>();
  /** Lines said but not yet shown, and lines whose end is still to be logged. */
  private lines = new Map<string, { key: string; duration: number; start?: number; ended?: boolean }>();
  private state: Record<string, unknown> = {};
  result?: TaskResult;
  /** Tasks 6 to 11 run as modules (core/tasks/office); tasks 1 to 5 are handled inline below. */
  private module?: OfficeTaskModule;
  private mctxCache?: ModuleCtx;
  private rngs = new Map<string, Rng>();

  constructor(
    /** 'baseline' for room 0, else the task id. */
    readonly id: TaskId | OfficeTaskId | 'baseline',
    readonly room: RoomSpec,
    private ctx: TaskContext,
  ) {
    if (isOfficeModule(id)) this.module = OFFICE_MODULES[id];
  }

  /** What a module may do: everything it logs is tagged with the office version. */
  private mctx(): ModuleCtx {
    if (this.mctxCache) return this.mctxCache;
    const id = this.id as OfficeTaskId;
    const self = this;
    this.mctxCache = {
      room: this.room,
      get p() { return self.p; },
      data: this.ctx.data,
      state: this.state,
      text: this.ctx.data.tasks.office[id],
      now: () => this.at,
      t0: () => this.t0,
      log: (type, data = {}) => this.log(type, { ...data, version: 'office' }),
      say: (key, text) => this.say(key, text ?? this.ctx.data.tasks.office[id].lines[key] ?? ''),
      emit: (effect) => this.ctx.emit(effect),
      ask: (a) => {
        this.ctx.emit({ kind: 'ask', ask: a });
        this.log('prompt_shown', { prompt: a.id, mode: a.mode, ...(a.mode === 'choice' ? { options: a.options } : {}), version: 'office' });
      },
      rng: (label) => {
        let r = this.rngs.get(label);
        if (!r) this.rngs.set(label, (r = createRng(deriveSeed(this.room.seed, `${id}:${label}`))));
        return r;
      },
      player: () => (this.last ? { x: this.last.x, z: this.last.z } : undefined),
      inZone: (zone) => this.inside.has(zone),
      exits: () => this.exits(),
    };
    return this.mctxCache;
  }

  private get p(): TaskParams {
    return this.room.task?.params ?? {};
  }

  /** Time of the event being handled (events can arrive a frame out of order with the 10 Hz samples). */
  private at = 0;

  private log(type: string, data: Record<string, unknown> = {}, t = this.at) {
    this.ctx.log.emit(this.id, type, data, t);
  }

  /** The player is in the room and can see it. */
  begin(t: number) {
    if (this.started) return;
    this.started = true;
    this.t0 = this.now = this.at = t;
    this.log('task_start', { room: this.room.index, params: this.p });
    const tx = this.ctx.data.tasks;
    switch (this.id) {
      case 'two_doors': {
        const side = String(this.p.instructedSide);
        const variant = tx.two_doors.instruction[Number(this.p.lineVariant) % tx.two_doors.instruction.length]!;
        this.say('instruction', variant.replaceAll('{side}', side).replaceAll('{other}', side === 'left' ? 'right' : 'left'));
        this.log('prompt_shown', { prompt: 'door', options: ['left', 'right'] });
        break;
      }
      case 'lift':
        this.say('enter', tx.lift.enter);
        this.state.floor = 0;
        this.state.nextFloorAt = t + 3.5;
        break;
      case 'desk':
        this.say('enter', tx.desk.enter);
        break;
      case 'meeting':
        this.say('enter', tx.meeting.enter);
        this.ctx.emit({ kind: 'timer', seconds: Number(this.p.countdown) || 13, label: tx.meeting.timerLabel });
        this.log('countdown_start', { seconds: Number(this.p.countdown) || 13 });
        break;
      case 'smoke':
        this.say('enter', tx.smoke.enter);
        this.log('prompt_shown', { prompt: 'fetch_file', options: ['fetch', 'ignore'] });
        // The exits stay shut until the smoke starts, so every player is still in the room when it does.
        this.ctx.emit({ kind: 'doors', locked: this.exits() });
        break;
    }
    this.module?.begin(this.mctx());
  }

  private exits(): string[] {
    return this.room.layout.doors.filter((d) => !d.entrance).map((d) => d.id);
  }

  /** Smoke from the vent: at `onset` seconds, or as soon as the player reaches the far desk. */
  private startSmoke(trigger: 'time' | 'desk') {
    if (this.state.smoke !== undefined) return;
    this.state.smoke = this.at;
    this.ctx.emit({ kind: 'smoke', from: String(this.p.ventProp), level: 1, seconds: Number(this.p.growth) || 60 });
    this.ctx.emit({ kind: 'doors', locked: [] });
    this.log('smoke_start', { growth: Number(this.p.growth) || 60, trigger });
  }

  onEvent(e: GameEvent) {
    if (this.finished || !this.started) return;
    if ('roomId' in e && e.roomId !== this.room.id) return;
    this.tick(e.t);
    this.at = e.t;
    switch (e.type) {
      case 'move':
        this.move(e.x, e.z, e.t);
        break;
      case 'input':
        this.log('input', { key: e.key, ...(e.target ? { target: e.target } : {}) });
        break;
      case 'prompt':
        this.log('prompt_shown', { prompt: e.objectId });
        break;
      case 'narrator_shown': {
        const line = this.lines.get(e.lineId);
        if (line && line.start === undefined) {
          line.start = e.t;
          this.log('narrator_start', { line: line.key, duration: line.duration });
        }
        break;
      }
      case 'inspected':
        this.log('interact', { object: e.objectId, action: 'inspect' });
        this.module?.onEvent?.(this.mctx(), e);
        break;
      case 'inspect_closed':
        this.log('interact', { object: e.objectId, action: 'inspect_close', seconds: e.seconds });
        this.module?.onEvent?.(this.mctx(), e);
        break;
      case 'answer':
        this.log('answer', { ask: e.askId, value: e.value, seconds: e.seconds });
        this.module?.onEvent?.(this.mctx(), e);
        break;
      case 'looked_at':
        this.log('interact', { object: e.objectId, action: 'look', seconds: e.seconds });
        break;
      case 'door_hovered':
        this.log('interact', { object: e.doorId, action: 'door_hover', seconds: e.seconds });
        break;
      case 'door_tried':
        this.log('interact', { object: e.doorId, action: 'door_tried' });
        if (this.id === 'smoke' && this.state.smoke === undefined && !this.state.toldLocked) {
          this.state.toldLocked = true;
          this.say('locked', this.ctx.data.tasks.smoke.locked);
        }
        this.module?.onEvent?.(this.mctx(), e);
        break;
      case 'pressed':
        if (this.module) this.module.onEvent?.(this.mctx(), e);
        else this.pressed(e.objectId);
        break;
      case 'hold_start':
        this.holdStart(e.objectId);
        break;
      case 'hold_end':
        this.holdEnd(e.objectId, e.seconds, e.completed);
        break;
      case 'door_chosen':
        this.chooseDoor(e.doorId);
        break;
    }
  }

  /** The player left (or the run moved on): score the task. */
  finish(outcome: string): TaskResult | undefined {
    if (this.finished || !this.started) return undefined;
    this.finished = true;
    // Lines still being spoken end on schedule, even if the player is gone.
    for (const line of this.lines.values()) {
      if (line.start !== undefined && !line.ended) {
        line.ended = true;
        this.log('narrator_end', { line: line.key }, line.start + line.duration);
      }
    }
    this.log('task_end', { outcome });
    if (this.id === 'baseline') return undefined;
    const events = this.ctx.log.slice(this.id);
    const score = scoreAny(this.id, events, { params: this.p, baseline: this.ctx.baseline(), all: this.ctx.log.events });
    this.result = {
      task: this.id,
      room: this.room.index,
      title: taskTitle(this.id, this.ctx.data),
      params: this.p,
      metrics: score.metrics,
      notes: score.notes,
    };
    if (this.module) this.module.profile?.(score.metrics, (trait, delta, reason) => this.ctx.profile.adjust(trait, delta, reason, this.room, this.now));
    else this.adjustProfile(score.metrics);
    return this.result;
  }

  /** This task's slice of the shared log. */
  events(): TaskEvent[] {
    return this.ctx.log.slice(this.id);
  }

  // ---------- internals ----------

  private say(key: string, text: string) {
    const lineId = `${this.room.id}:${key}`;
    this.lines.set(lineId, { key, duration: lineSeconds(text) });
    this.ctx.say(text, lineId);
  }

  /** Advance the run clock: end lines, and fire the task's scripted moments. */
  private tick(t: number) {
    if (t < this.now) return;
    this.now = this.at = t;
    for (const line of this.lines.values()) {
      if (line.start !== undefined && !line.ended && t >= line.start + line.duration) {
        line.ended = true;
        this.log('narrator_end', { line: line.key }, line.start + line.duration);
      }
    }
    const tx = this.ctx.data.tasks;
    const since = t - this.t0;
    switch (this.id) {
      case 'lift': {
        // The indicator crawls towards the player, then hovers a floor or two away. It never arrives.
        const floors = tx.lift.floors;
        const n = floors.length;
        if (t >= Number(this.state.nextFloorAt)) {
          const step = Number(this.state.floor) + 1;
          this.state.floor = step;
          const text = step < n ? floors[step]! : floors[n - 1 - ((step - n + 1) % 2)]!;
          this.ctx.emit({ kind: 'display', prop: String(this.p.liftProp), text });
          this.state.nextFloorAt = t + (step < n - 1 ? 3.5 : 5);
        }
        if (!this.state.hinted && since >= (Number(this.p.timeout) || 90)) {
          this.state.hinted = true;
          this.say('hint', tx.lift.hint);
          this.log('outcome', { hint: true });
        }
        break;
      }
      case 'meeting': {
        const countdown = Number(this.p.countdown) || 13;
        if (!this.state.late && since >= countdown) {
          this.state.late = true;
          this.ctx.emit({ kind: 'timer', seconds: null, label: '' });
          this.say('late', tx.meeting.late);
          this.log('countdown_end', {});
        }
        break;
      }
      case 'smoke': {
        if (since >= (Number(this.p.onset) || 8)) this.startSmoke('time');
        // One of the calm workers glances at the smoke and goes back to typing.
        const workers = String(this.p.workerProps ?? '').split(',').filter(Boolean);
        if (this.state.smoke !== undefined && !this.state.glanced && workers.length && t >= Number(this.state.smoke) + 8) {
          this.state.glanced = true;
          this.ctx.emit({ kind: 'glance', prop: workers[0]!, at: String(this.p.ventProp), seconds: 2.5 });
          this.log('outcome', { glance: workers[0] });
        }
        break;
      }
    }
    this.module?.tick?.(this.mctx(), t);
  }

  private move(x: number, z: number, t: number) {
    const prev = this.last;
    const dt = prev ? t - prev.t : 0;
    const vx = prev && dt > 0 ? (x - prev.x) / dt : 0;
    const vz = prev && dt > 0 ? (z - prev.z) / dt : 0;
    this.last = { t, x, z };
    this.log('move', { x: r3(x), z: r3(z), vx: r3(vx), vz: r3(vz) });
    for (const zone of this.room.layout.zones ?? []) {
      const inside = Math.hypot(x - zone.x, z - zone.z) <= zone.r;
      if (inside && !this.inside.has(zone.id)) {
        this.inside.add(zone.id);
        this.log('zone_enter', { zone: zone.id });
        this.enteredZone(zone.id);
        this.module?.onZone?.(this.mctx(), zone.id, true);
      } else if (!inside && this.inside.has(zone.id)) {
        this.inside.delete(zone.id);
        this.log('zone_exit', { zone: zone.id });
        this.module?.onZone?.(this.mctx(), zone.id, false);
      }
    }
  }

  private enteredZone(zone: string) {
    if (this.id === 'meeting' && zone === 'colleague' && !this.state.asked) {
      this.state.asked = true;
      this.say('ask', this.ctx.data.tasks.meeting.ask);
      this.log('prompt_shown', { prompt: 'help', options: ['help', 'ignore'], clock: this.clock() });
    }
    if (this.id === 'smoke' && zone === 'file_desk') this.startSmoke('desk');
  }

  private pressed(objectId: string) {
    const tx = this.ctx.data.tasks;
    const p = this.p;
    if (this.id === 'lift' && objectId === p.callProp) {
      this.log('interact', { object: objectId, action: 'press' });
    } else if (this.id === 'smoke' && objectId === p.alarmProp) {
      this.log('interact', { object: objectId, action: 'alarm' });
      if (!this.state.alarm) {
        this.state.alarm = true;
        this.ctx.emit({ kind: 'alarm', on: true });
        this.say('alarm', tx.smoke.alarm);
      }
    } else if (this.id === 'smoke' && objectId === p.fileProp) {
      if (this.state.file) return;
      this.state.file = true;
      this.log('interact', { object: objectId, action: 'pickup' });
      this.log('choice', { prompt: 'fetch_file', chosen: 'fetch', context: { smoke: this.state.smoke !== undefined } });
      this.ctx.emit({ kind: 'hide', prop: objectId });
      this.say('file', tx.smoke.fileTaken);
    } else if (this.id === 'smoke' && String(p.workerProps ?? '').split(',').includes(objectId)) {
      const n = Number(this.state.talks ?? 0);
      this.state.talks = n + 1;
      this.log('interact', { object: objectId, action: 'talk' });
      // They turn to look at the player, answer, and go back to typing. Before the smoke it's small talk;
      // after it, the calm brush-off the task is about.
      this.ctx.emit({ kind: 'glance', prop: objectId, at: 'player', seconds: 2.2 });
      const lines = this.state.smoke === undefined ? tx.smoke.workersBefore : tx.smoke.workers;
      this.say(`worker${n}`, lines[n % lines.length]!);
    } else {
      this.log('interact', { object: objectId, action: 'press' });
    }
  }

  private holdStart(objectId: string) {
    if (this.state.helped) return; // fixed once; the printer is done
    this.log('interact', { object: objectId, action: 'hold_start', clock: this.clock() });
  }

  private holdEnd(objectId: string, seconds: number, completed: boolean) {
    if (this.state.helped) return;
    this.log('interact', { object: objectId, action: 'hold_end', seconds, completed, clock: this.clock() });
    if (this.id === 'meeting' && completed) {
      this.state.helped = true;
      this.log('choice', { prompt: 'help', chosen: 'help', context: { clock: this.clock() } });
      this.ctx.emit({ kind: 'display', prop: String(this.p.printerProp), text: 'READY' });
      this.ctx.emit({ kind: 'disable', prop: String(this.p.printerProp) });
      this.say('thanks', this.ctx.data.tasks.meeting.thanks);
    }
  }

  private chooseDoor(doorId: string) {
    const p = this.p;
    switch (this.id) {
      case 'two_doors': {
        const side = doorId === p.leftDoor ? 'left' : 'right';
        this.log('interact', { object: doorId, action: 'open' });
        this.log('choice', { prompt: 'door', chosen: side, context: { instructed: p.instructedSide } });
        break;
      }
      case 'meeting':
        if (this.state.asked && !this.state.helped) this.log('choice', { prompt: 'help', chosen: 'ignore', context: { clock: this.clock() } });
        this.log('choice', { prompt: 'door', chosen: doorId === p.secretDoor ? 'secret' : 'board', secretOffered: true, context: { clock: this.clock() } });
        break;
      case 'smoke':
        if (!this.state.file) this.log('choice', { prompt: 'fetch_file', chosen: 'ignore', context: { smoke: this.state.smoke !== undefined } });
        this.log('choice', { prompt: 'door', chosen: doorId === p.fireExitDoor ? 'fire_exit' : 'other' });
        this.ctx.emit({ kind: 'alarm', on: false });
        break;
      default:
        this.log('choice', { prompt: 'door', chosen: doorId, ...(this.module ? { version: 'office' } : {}) });
        if (this.module) {
          this.module.onLeave?.(this.mctx(), doorId);
          this.ctx.emit({ kind: 'ask_close', id: '*' });
        }
    }
    this.finish('left');
  }

  /** Seconds left on the meeting countdown. */
  private clock(): number | undefined {
    if (this.id !== 'meeting') return undefined;
    return Math.max(0, Math.round(((Number(this.p.countdown) || 13) - (this.now - this.t0)) * 10) / 10);
  }

  /** Tasks feed the hidden profile too, so the room generator and the dossier see them. */
  private adjustProfile(m: Record<string, number | null>) {
    const { profile } = this.ctx;
    const room = this.room;
    const t = this.now;
    switch (this.id) {
      case 'two_doors':
        if (m.compliance === 1) profile.adjust('compliance', 0.2, 'took the door it was told to take', room, t);
        else if (m.compliance === 0) profile.adjust('compliance', -0.22, 'took the maintenance door it was told not to use', room, t);
        if ((m.early_action ?? 0) >= 0.5) profile.adjust('impulsivity', 0.08, 'was already moving before the instruction finished', room, t);
        break;
      case 'lift':
        if ((m.button_presses ?? 0) >= 5) profile.adjust('impulsivity', 0.12, `pressed the lift button ${m.button_presses} times`, room, t);
        if (m.self_rescue === 0) profile.adjust('hesitation', 0.12, 'waited for a lift that never came until told about the stairs', room, t);
        else if (m.self_rescue === 1 && (m.seconds_waited ?? 99) < 30) profile.adjust('hesitation', -0.08, 'gave up on the lift and took the stairs', room, t);
        break;
      case 'desk':
        if ((m.items_inspected ?? 0) >= 0.6) profile.adjust('curiosity', 0.12, 'went through the abandoned desk', room, t);
        else if (m.items_inspected === 0) profile.adjust('curiosity', -0.1, 'walked straight past the abandoned desk', room, t);
        break;
      case 'smoke':
        if (m.kept_on_task === 1) profile.adjust('compliance', 0.1, 'fetched the file before dealing with the smoke', room, t);
        if ((m.reaction_latency ?? 0) > 30) profile.adjust('hesitation', 0.1, `took ${Math.round(m.reaction_latency!)} s to react to the smoke`, room, t);
        break;
    }
  }
}

function r3(n: number) {
  return Math.round(n * 1000) / 1000;
}
