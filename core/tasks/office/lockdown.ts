import { Builder } from '../../room/layouts';
import { pick } from '../../util/random';
import { cells, onWall } from '../layouts';
import { robustZ, samples } from '../metrics';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { first, of, r2 } from './util';

/**
 * 11. The Lockdown: what you do when you can't leave.
 *
 * "Security drill. Please remain in the meeting suite until it is lifted."
 * The doors lock; no timer is shown. Two rooms joined by an open doorway:
 * the empty room (where the player starts) with one chair and a small
 * "Do not press" button that buzzes harshly and shakes the view, and the
 * task room with a pile of unsorted files and three labelled trays. An
 * intercom by the door only ever answers "The drill is still in progress."
 * After `duration` seconds the doors unlock with just a click.
 *
 * Wilson et al. (2014, "Just think"): the buzzer is a harmless stand-in for
 * the shock button. Boredom proneness (Farmer and Sundberg, 1986).
 * Ethics: 90 s by default (2 minutes at most), capped buzz volume, no
 * flashing, and the narrator says at the start that it is only a drill.
 */
export const KINDS = ['INVOICE', 'MEMO', 'CONTRACT'] as const;

export const lockdown: OfficeTaskModule = {
  id: 'lockdown',
  number: '11',
  needs: {
    fixtures: [
      { id: 't_buzzer', recipe: 'buzzer_button', what: 'empty room: the "Do not press" button' },
      { id: 't_intercom', recipe: 'intercom', what: 'empty room, by the door: calls the narrator' },
      { id: 't_chair', recipe: 'chair_office', what: 'empty room: the only furniture' },
      { id: 't_pile', recipe: 'file_pile', what: 'task room: the unsorted files (pressing takes one)' },
      { id: 't_tray1', recipe: 'file_tray', what: 'task room: tray for invoices' },
      { id: 't_tray2', recipe: 'file_tray', what: 'task room: tray for memos' },
      { id: 't_tray3', recipe: 'file_tray', what: 'task room: tray for contracts' },
    ],
    zones: [
      { id: 'room_empty', what: 'the empty room' },
      { id: 'room_task', what: 'the task room' },
    ],
    doors: 'all exits locked for the lock-in, then unlocked silently',
  },

  defaults: () => ({ duration: 90, files: 40 }),

  layout(_p, rng, data) {
    const W = 13, D = 7;
    const t = data.tasks.office.lockdown;
    const b = new Builder('meeting_suite', W, D, 2.8, { rng, doorLabels: [] });
    // A wall down the middle with one open doorway between the two rooms.
    for (let z = 0; z < D; z++) if (z !== 3) b.solid(6, z);
    const ex = b.entrance(2);
    const exit = b.door('n', 3, { label: t.labels!.exit });
    b.fixture({ id: 't_intercom', recipe: 'intercom', ...onWall('n', 4.4, W, D, 0.05), y: 1.4 });
    b.fixture({ id: 't_buzzer', recipe: 'buzzer_button', ...onWall('w', 3.5, W, D, 0.06), y: 1.3, surfaceText: t.labels!.buzzer });
    b.fixture({ id: 't_chair', recipe: 'chair_office', x: 3, z: 3.5, face: 's', y: 0 });
    // Task room: a desk with the pile and three trays.
    b.fixture({ id: 't_desk', recipe: 'desk_bare', x: 9.5, z: 0.4, face: 's', y: 0 }, cells(8, 0, 11, 1));
    b.fixture({ id: 't_pile', recipe: 'file_pile', x: 9.0, z: 0.5, face: 's', y: 0.75, surfaceText: `${t.labels!.pile}\n40` });
    ['tray1', 'tray2', 'tray3'].forEach((id, i) => {
      b.fixture({ id: `t_${id}`, recipe: 'file_tray', x: 9.55 + i * 0.36, z: 0.5, face: 's', y: 0.75, surfaceText: `${KINDS[i]}S` });
    });
    b.reserve(cells(0, 2, 0, 5));
    b.reserve(cells(2, 0, 5, 0));
    b.zone({ id: 'room_empty', x: 3, z: 3.5, r: 3.4 });
    b.zone({ id: 'room_task', x: 9.5, z: 3.5, r: 3.4 });
    b.wallSlots(['wall_mounted']);
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    ctx.state.left = Number(ctx.p.files) || 40;
    ctx.emit({ kind: 'doors', locked: ctx.exits() });
    ctx.emit({ kind: 'sound', name: 'clunk' });
    ctx.log('lock', { duration: Number(ctx.p.duration) || 90 });
    ctx.say('start');
  },

  tick(ctx, t) {
    const s = ctx.state;
    if (!s.unlocked && t - ctx.t0() >= Math.min(120, Number(ctx.p.duration) || 90)) {
      s.unlocked = t;
      ctx.emit({ kind: 'doors', locked: [] });
      ctx.emit({ kind: 'sound', name: 'click' });
      ctx.log('unlock', {});
    }
  },

  onEvent(ctx, e) {
    const s = ctx.state;
    if (e.type === 'door_tried') {
      ctx.log('door_try', { door: e.doorId, third: third(ctx) });
      return;
    }
    if (e.type !== 'pressed') return;
    if (e.objectId === 't_buzzer') {
      ctx.log('buzz', {});
      ctx.emit({ kind: 'sound', name: 'buzz' });
      ctx.emit({ kind: 'shake', seconds: 0.45 });
    } else if (e.objectId === 't_intercom') {
      ctx.log('intercom', {});
      ctx.say(`drill${Number(s.calls ?? 0)}`, ctx.text.lines.drill);
      s.calls = Number(s.calls ?? 0) + 1;
    } else if (e.objectId === 't_pile') {
      if (s.holding || Number(s.left) <= 0) return;
      const kind = pick(ctx.rng('files'), KINDS);
      s.holding = kind;
      s.left = Number(s.left) - 1;
      ctx.log('file_take', { kind });
      ctx.emit({ kind: 'sound', name: 'paper' });
      ctx.emit({ kind: 'display', prop: 't_pile', text: `${ctx.text.labels!.pile}\n${s.left}` });
      ctx.emit({ kind: 'status', text: `${ctx.text.labels!.holding}: ${kind} #${2200 + Number(s.left)}` });
    } else if (/^t_tray\d$/.test(e.objectId) && s.holding) {
      const tray = KINDS[Number(e.objectId.slice(-1)) - 1];
      const correct = tray === s.holding;
      ctx.log('file_sorted', { correct, kind: s.holding, tray, afterUnlock: s.unlocked !== undefined });
      ctx.emit({ kind: 'sound', name: 'paper' });
      ctx.emit({ kind: 'status', text: null });
      s.holding = undefined;
    }
  },

  onLeave(ctx) {
    ctx.emit({ kind: 'status', text: null });
  },

  score(ev, { baseline }) {
    const lock = first(ev, 'lock');
    const unlock = first(ev, 'unlock');
    if (!lock) return { metrics: {}, notes: [] };
    const dur = Number(lock.data.duration) || 90;
    const lockEnd = unlock?.t ?? ev.at(-1)?.t ?? lock.t;
    const during = (t: number) => t >= lock.t && t <= lockEnd;
    const tries = of(ev, 'door_try').filter((e) => during(e.t));
    const third = (n: number) => tries.filter((e) => e.t - lock.t >= (dur / 3) * n && e.t - lock.t < (dur / 3) * (n + 1)).length;
    const buzzes = of(ev, 'buzz');
    const sorted = of(ev, 'file_sorted');
    // Peak spam: most door tries and buzzer presses in any 5 s window, against the baseline input rate.
    const presses = [...tries, ...buzzes].map((e) => e.t).sort((a, b) => a - b);
    let peak = 0;
    for (const t of presses) peak = Math.max(peak, presses.filter((x) => x >= t && x < t + 5).length);
    // Time in each room from zone enter/exit events, within the lock-in.
    const ss = samples(ev).filter((s) => during(s.t));
    const inTask = roomTimes(ev, 'room_task', lock.t, lockEnd);
    const enterTask = first(ev, 'zone_enter', (d) => d.zone === 'room_task');
    // Pacing: distance per minute while in the empty room.
    let dist = 0, emptyTime = 0;
    const emptyInt = intervals(ev, 'room_empty', lock.t, lockEnd);
    for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1]!, b = ss[i]!;
      if (emptyInt.some(([s, e]) => a.t >= s && b.t <= e)) { dist += Math.hypot(b.x - a.x, b.z - a.z); emptyTime += b.t - a.t; }
    }
    const pace = emptyTime >= 5 ? (dist / emptyTime) * 60 : null;
    const afterUnlock = unlock ? [...of(ev, 'door_try'), ...of(ev, 'choice', (d) => d.prompt === 'door')].filter((e) => e.t >= unlock.t).sort((a, b) => a.t - b.t)[0] : undefined;
    const metrics = {
      lock_seconds: r2(lockEnd - lock.t),
      escape_attempts: tries.length,
      escalation: third(2) - third(0),
      peak_spam_rate: presses.length && baseline?.inputRate ? r2(peak / 5 / baseline.inputRate) : null,
      time_to_explore: enterTask ? r2(enterTask.t - lock.t) : null,
      task_room_share: r2(inTask / Math.max(1, lockEnd - lock.t)),
      files_sorted: sorted.length,
      sort_accuracy: sorted.length ? r2(sorted.filter((s) => s.data.correct).length / sorted.length) : null,
      buzzer_presses: buzzes.length,
      time_to_first_buzz: buzzes.length ? r2(buzzes[0]!.t - lock.t) : null,
      idle_share: ss.length >= 20 ? r2(ss.filter((s) => s.speed < 0.1).length / ss.length) : null,
      pacing: r2(pace),
      // Against the player's own walking speed (m/s) from the baseline room, as metres per second.
      pacing_z: pace !== null ? r2(robustZ(pace / 60, baseline?.speed ?? null, baseline?.speedMad ?? null, 0.2)) : null,
      help_seeking: of(ev, 'intercom').length,
      notices_unlock: unlock && afterUnlock ? r2(afterUnlock.t - unlock.t) : null,
      finishes_job: unlock ? (sorted.some((s) => s.data.afterUnlock) ? 1 : 0) : null,
    };
    const secs = Math.round(lockEnd - lock.t);
    const notes = [
      `Locked in for ${secs} seconds, you tried the door ${tries.length} time${tries.length === 1 ? '' : 's'}, pressed the forbidden button ${buzzes.length} time${buzzes.length === 1 ? '' : 's'}, and sorted ${sorted.length || 'no'} file${sorted.length === 1 ? '' : 's'}.`,
    ];
    if (buzzes.length && buzzes[0]!.t - lock.t < 30) notes.push(`You pressed it within ${Math.round(buzzes[0]!.t - lock.t)} s of the doors locking.`);
    if (metrics.escalation >= 3) notes.push('Your tries at the door picked up as time went on.');
    return { metrics, notes };
  },

  profile(m, adjust) {
    if ((m.buzzer_presses ?? 0) >= 2) adjust('impulsivity', 0.1, `pressed the "do not press" button ${m.buzzer_presses} times during the drill`);
    if ((m.escape_attempts ?? 0) >= 6) adjust('compliance', -0.08, `tried the locked door ${m.escape_attempts} times during the drill`);
    if ((m.files_sorted ?? 0) >= 5) adjust('curiosity', 0.06, 'found something to do during the drill');
  },
};

function third(ctx: ModuleCtx): number {
  const d = Number(ctx.p.duration) || 90;
  return Math.min(3, Math.floor((ctx.now() - ctx.t0()) / (d / 3)) + 1);
}

/** Intervals [enter, exit] the player spent in a zone, clipped to [from, to]. */
function intervals(ev: { t: number; type: string; data: Record<string, unknown> }[], zone: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let since: number | undefined;
  for (const e of ev) {
    if (e.data.zone !== zone) continue;
    if (e.type === 'zone_enter') since = e.t;
    else if (e.type === 'zone_exit' && since !== undefined) { out.push([since, e.t]); since = undefined; }
  }
  if (since !== undefined) out.push([since, to]);
  return out.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number]).filter(([a, b]) => b > a);
}

function roomTimes(ev: { t: number; type: string; data: Record<string, unknown> }[], zone: string, from: number, to: number): number {
  return intervals(ev, zone, from, to).reduce((a, [s, e]) => a + e - s, 0);
}
