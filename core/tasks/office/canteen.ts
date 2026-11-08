import { Builder } from '../../room/layouts';
import { createRng, deriveSeed } from '../../util/random';
import { against, cells } from '../layouts';
import { robustZ } from '../metrics';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { of, r2 } from './util';

/**
 * 8. The Canteen Queue (office version of the Lamp Oil): patience.
 *
 * Delay discounting with real waits. An energy bar slowly drains. At each
 * stop the player can take something small now, or queue for something
 * bigger (the hot meal coming out of the kitchen). The wait is real, and
 * walking away early forfeits it. Each stop is optional, so the office gives
 * 0 to 4 offers. The six fixed offers are split between office and mine so
 * each version gets a mix of easy and hard ones; k at indifference is
 * (later / now - 1) / wait.
 */
export const OFFERS = [
  { id: 1, now: 45, later: 50, wait: 30 },
  { id: 2, now: 40, later: 50, wait: 25 },
  { id: 3, now: 30, later: 50, wait: 20 },
  { id: 4, now: 25, later: 50, wait: 10 },
  { id: 5, now: 20, later: 50, wait: 5 },
  { id: 6, now: 10, later: 50, wait: 4 },
];
/** The office's share of the six offers (the mine gets 2 and 5, plus any the player skipped here). */
export const OFFICE_OFFERS = [1, 3, 4, 6];
export const kOf = (o: { now: number; later: number; wait: number }) => (o.later / o.now - 1) / o.wait;

const STATIONS = 4;

export const canteen: OfficeTaskModule = {
  id: 'canteen',
  number: '8',
  needs: {
    fixtures: Array.from({ length: STATIONS }, (_, i) => [
      { id: `t_now${i + 1}`, recipe: 'food_counter', what: `stop ${i + 1}: the small thing, taken at once` },
      { id: `t_wait${i + 1}`, recipe: 'queue_sign', what: `stop ${i + 1}: where to queue for the bigger thing` },
    ]).flat(),
    zones: Array.from({ length: STATIONS }, (_, i) => ({ id: `stop${i + 1}`, what: `around stop ${i + 1}; leaving it while queueing forfeits the wait` })),
    doors: 'one exit, always open',
  },

  defaults(seed) {
    // Shuffled order, so offers aren't always met easiest-first.
    const rng = createRng(deriveSeed(seed, 'canteen-offers'));
    const order = [...OFFICE_OFFERS].sort(() => rng() - 0.5);
    return { offers: order.join(','), energy: 60, drain: 0.4 };
  },

  layout(_p, rng, data) {
    const W = 10, D = 8;
    const t = data.tasks.office.canteen;
    const b = new Builder('canteen', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(5);
    const exit = b.door('n', 5, { label: t.labels!.exit });
    // Two stops on the west wall, two on the east, each a counter and a queue mark beside it.
    const spots: { side: 'w' | 'e'; z: number }[] = [{ side: 'w', z: 2.5 }, { side: 'w', z: 5.5 }, { side: 'e', z: 2.5 }, { side: 'e', z: 5.5 }];
    spots.forEach(({ side, z }, i) => {
      const n = i + 1;
      b.fixture({ id: `t_now${n}`, recipe: 'food_counter', ...against(side, z - 0.6, W, D, 0.6), y: 0, surfaceText: '...' }, cells(side === 'w' ? 0 : W - 1, Math.floor(z) - 1, side === 'w' ? 1 : W - 1, Math.floor(z) + 1));
      const qx = side === 'w' ? 1.5 : W - 1.5;
      b.fixture({ id: `t_wait${n}`, recipe: 'queue_sign', x: qx, z: z + 0.55, face: side === 'w' ? 'e' : 'w', y: 0, surfaceText: '...' });
      b.zone({ id: `stop${n}`, x: qx, z: z + 0.3, r: 1.7 });
    });
    b.wallSlots(['wall_mounted']);
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    ctx.state.energy = Number(ctx.p.energy) || 60;
    ctx.state.used = [];
    ctx.say('intro');
    const offers = offersOf(ctx);
    const names = ctx.text.labels!;
    offers.forEach((o, i) => {
      const n = i + 1;
      ctx.emit({ kind: 'display', prop: `t_now${n}`, text: `${names[`now${n}`]}\nNOW  +${o.now}` });
      ctx.emit({ kind: 'display', prop: `t_wait${n}`, text: `${names[`later${n}`]}\nWAIT ${o.wait}s  +${o.later}` });
    });
    status(ctx);
  },

  tick(ctx, t) {
    const s = ctx.state;
    // Energy drains slowly in the background (presentation only; it makes the offers matter).
    if (s.lastDrain === undefined) s.lastDrain = t;
    if (t - Number(s.lastDrain) >= 2) {
      s.energy = Math.max(0, Number(s.energy) - Number(ctx.p.drain || 0.4) * (t - Number(s.lastDrain)));
      s.lastDrain = t;
      status(ctx);
    }
    const w = s.waiting as { stop: number; offer: number; since: number; wait: number } | undefined;
    if (w && t - w.since >= w.wait) {
      const o = OFFERS.find((x) => x.id === w.offer)!;
      s.waiting = undefined;
      ctx.log('wait_end', { offer: o.id, elapsed: r2(t - w.since) });
      s.energy = Number(s.energy) + o.later;
      ctx.emit({ kind: 'timer', seconds: null, label: '' });
      ctx.emit({ kind: 'sound', name: 'ding' });
      done(ctx, w.stop, ctx.text.labels!.served!);
      ctx.say('served');
    }
  },

  onZone(ctx, zone, entered) {
    const stop = Number(zone.replace('stop', ''));
    if (!stop) return;
    const o = offersOf(ctx)[stop - 1];
    if (!o) return;
    if (entered && !(ctx.state.shown as number[] | undefined)?.includes(stop)) {
      ctx.state.shown = [...((ctx.state.shown as number[]) ?? []), stop];
      ctx.log('prompt_shown', { prompt: `offer${o.id}`, offer: o.id, now: o.now, later: o.later, wait: o.wait, k: r2(kOf(o)) });
    }
    const w = ctx.state.waiting as { stop: number; offer: number; since: number } | undefined;
    if (!entered && w && w.stop === stop) {
      // Walked away from the queue: the bigger meal is forfeit.
      ctx.state.waiting = undefined;
      ctx.log('wait_abandon', { offer: w.offer, elapsed: r2(ctx.now() - w.since) });
      ctx.emit({ kind: 'timer', seconds: null, label: '' });
      done(ctx, stop, ctx.text.labels!.gone!);
    }
  },

  onEvent(ctx, e) {
    if (e.type !== 'pressed') return;
    const m = /^t_(now|wait)(\d)$/.exec(e.objectId);
    if (!m) return;
    const stop = Number(m[2]);
    const used = ctx.state.used as number[];
    if (used.includes(stop) || ctx.state.waiting) return;
    const o = offersOf(ctx)[stop - 1];
    if (!o) return;
    if (m[1] === 'now') {
      ctx.log('choice', { prompt: `offer${o.id}`, offer: o.id, chosen: 'now', k: r2(kOf(o)) });
      ctx.state.energy = Number(ctx.state.energy) + o.now;
      ctx.emit({ kind: 'sound', name: 'paper' });
      done(ctx, stop, ctx.text.labels!.taken!);
    } else {
      ctx.log('choice', { prompt: `offer${o.id}`, offer: o.id, chosen: 'later', k: r2(kOf(o)) });
      ctx.log('wait_start', { offer: o.id, wait: o.wait });
      ctx.state.waiting = { stop, offer: o.id, since: ctx.now(), wait: o.wait };
      ctx.emit({ kind: 'timer', seconds: o.wait, label: ctx.text.labels!.timer! });
    }
  },

  onLeave(ctx) {
    ctx.emit({ kind: 'status', text: null });
    ctx.emit({ kind: 'timer', seconds: null, label: '' });
  },

  score(ev, { baseline }) {
    const choices = of(ev, 'choice', (d) => String(d.prompt).startsWith('offer'));
    const later = choices.filter((c) => c.data.chosen === 'later');
    const starts = of(ev, 'wait_start'), abandons = of(ev, 'wait_abandon');
    // k: geometric mean of the largest k where they took "now" and the smallest k where they waited.
    const nowKs = choices.filter((c) => c.data.chosen === 'now').map((c) => Number(c.data.k));
    const laterKs = later.map((c) => Number(c.data.k));
    let k: number | null = null;
    if (choices.length) {
      if (!nowKs.length) k = 0.004; // always waited: below the smallest offer's k
      else if (!laterKs.length) k = 1.0; // never waited: above the largest
      else k = Math.sqrt(Math.max(...nowKs) * Math.min(...laterKs));
    }
    // Fidget while waiting: movement (m/s) plus inputs per second, against the same measure in the baseline room.
    let activity = 0, seconds = 0;
    for (const s of starts) {
      const end = [...of(ev, 'wait_end'), ...abandons].find((x) => x.data.offer === s.data.offer)?.t ?? ev.at(-1)?.t ?? s.t;
      const mv = of(ev, 'move').filter((m) => m.t >= s.t && m.t <= end);
      for (let i = 1; i < mv.length; i++) activity += Math.hypot(Number(mv[i]!.data.x) - Number(mv[i - 1]!.data.x), Number(mv[i]!.data.z) - Number(mv[i - 1]!.data.z));
      activity += of(ev, 'input').filter((x) => x.t >= s.t && x.t <= end).length;
      seconds += end - s.t;
    }
    const fidget = seconds >= 2 ? activity / seconds : null;
    const metrics = {
      offers: choices.length,
      later_share: choices.length ? r2(later.length / choices.length) : null,
      estimated_k: k === null ? null : Math.round(k * 10000) / 10000,
      abandon_rate: starts.length ? r2(abandons.length / starts.length) : null,
      fidget_during_wait: r2(fidget),
      fidget_during_wait_z: r2(robustZ(fidget, baseline?.activity ?? null, null, 0.3)),
      voluntary_repetitions: choices.length,
    };
    const notes: string[] = [];
    if (!choices.length) notes.push('You skipped lunch.');
    else {
      notes.push(`At the canteen you chose to wait ${later.length} of ${choices.length} time${choices.length === 1 ? '' : 's'}.`);
      if (abandons.length) notes.push(`You gave up on the queue ${abandons.length === 1 ? 'once' : `${abandons.length} times`} before the food arrived.`);
    }
    return { metrics, notes };
  },

  profile(m, adjust) {
    if (m.later_share === null || m.later_share === undefined) return;
    if (m.later_share >= 0.75 && !m.abandon_rate) adjust('impulsivity', -0.08, 'waited in the canteen queue for the better food');
    else if (m.later_share <= 0.25) adjust('impulsivity', 0.08, 'took the canteen food that was there now');
  },
};

function offersOf(ctx: ModuleCtx) {
  return String(ctx.p.offers).split(',').map((id) => OFFERS.find((o) => o.id === Number(id))!).slice(0, STATIONS);
}

function done(ctx: ModuleCtx, stop: number, text: string) {
  (ctx.state.used as number[]).push(stop);
  ctx.emit({ kind: 'display', prop: `t_now${stop}`, text });
  ctx.emit({ kind: 'display', prop: `t_wait${stop}`, text });
  ctx.emit({ kind: 'disable', prop: `t_now${stop}` });
  ctx.emit({ kind: 'disable', prop: `t_wait${stop}` });
  status(ctx);
}

function status(ctx: ModuleCtx) {
  ctx.emit({ kind: 'status', text: `${ctx.text.labels!.energy}: ${Math.round(Number(ctx.state.energy))}` });
}
