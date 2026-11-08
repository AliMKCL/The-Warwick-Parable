import { Builder } from '../../room/layouts';
import { randInt, type Rng } from '../../util/random';
import { cells, onWall } from './geometry';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { mean, of, r2, slope } from './util';

/**
 * 6. Party Balloons (office version of the Ore Drill): risk appetite and reaction to losses.
 *
 * The Balloon Analogue Risk Task (Lejuez et al., 2002). Each pump inflates the
 * balloon and adds a point; tying it off banks the points; at a hidden,
 * uniformly drawn point (1 to maxPumps) it pops and the points are lost.
 * No probability information is ever shown. The player inflates anywhere
 * from 0 to `balloons` before leaving the party room.
 *
 * Events use the spec's shared names so office and mine score the same way:
 * vein_start (with the hidden break point), pump, bank, collapse.
 */
export const balloons: OfficeTaskModule = {
  id: 'balloons',
  number: '6',
  needs: {
    fixtures: [
      { id: 't_pump', recipe: 'balloon_pump', what: 'a table with a hand pump: pressing it adds one pump' },
      { id: 't_balloon', recipe: 'balloon', what: 'the balloon being inflated, on the table: pressing it ties it off (banks)' },
      { id: 't_score', recipe: 'whiteboard', what: 'a wall board showing the party score' },
    ],
    zones: [{ id: 'party', what: 'around the pump table' }],
    doors: 'one exit, always open',
  },

  defaults: () => ({ maxPumps: 32, balloons: 10, value: 1 }),

  layout(_p, rng, data) {
    const W = 8, D = 8;
    const t = data.tasks.office.balloons;
    const b = new Builder('party_room', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(3);
    const exit = b.door('n', 5, { label: t.labels!.exit });
    b.fixture({ id: 't_pump', recipe: 'balloon_pump', x: 3.5, z: 3.6, face: 's', y: 0 }, cells(2, 2, 5, 4));
    b.fixture({ id: 't_balloon', recipe: 'balloon', x: 3.1, z: 3.55, face: 's', y: 0.78 });
    b.fixture({ id: 't_score', recipe: 'whiteboard', ...onWall('w', 3.5, W, D, 0.05), y: 1.55, surfaceText: `${t.labels!.score}\n0`, inspectText: t.labels!.scoreInspect });
    b.fixture({ id: 't_banner', recipe: 'sign_wall', ...onWall('n', 2, W, D, 0.03), y: 2.2, surfaceText: t.labels!.banner, inspectText: t.labels!.banner });
    b.reserve(cells(0, 2, 0, 5));
    b.zone({ id: 'party', x: 3.5, z: 3.8, r: 2.4 });
    b.wallSlots();
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    ctx.say('intro');
    ctx.state.score = 0;
    ctx.emit({ kind: 'status', text: `${ctx.text.labels!.score}: 0` });
    next(ctx);
  },

  onEvent(ctx, e) {
    if (e.type !== 'pressed') return;
    const s = ctx.state;
    if (s.done) {
      if (!s.toldDone) { s.toldDone = true; ctx.say('done'); }
      return;
    }
    if (e.objectId === 't_pump' && s.pumps !== undefined) {
      const pumps = Number(s.pumps) + 1;
      s.pumps = pumps;
      ctx.log('interact', { object: e.objectId, action: 'pump' });
      ctx.log('pump', { vein: s.balloon, pumps });
      ctx.emit({ kind: 'sound', name: 'squeak' });
      if (pumps >= Number(s.breakAt)) {
        ctx.log('collapse', { vein: s.balloon, pumps });
        ctx.emit({ kind: 'sound', name: 'pop' });
        ctx.emit({ kind: 'scale', prop: 't_balloon', scale: 0 });
        if (!s.toldPop) { s.toldPop = true; ctx.say('pop'); }
        s.pumps = undefined; // a fresh balloon appears a moment later
        s.nextAt = ctx.now() + 0.9;
      } else {
        ctx.emit({ kind: 'scale', prop: 't_balloon', scale: size(pumps) });
      }
    } else if (e.objectId === 't_balloon' && s.pumps !== undefined && Number(s.pumps) > 0) {
      const pumps = Number(s.pumps);
      ctx.log('interact', { object: e.objectId, action: 'tie' });
      ctx.log('bank', { vein: s.balloon, pumps });
      s.score = Number(s.score) + pumps * (Number(ctx.p.value) || 1);
      ctx.emit({ kind: 'sound', name: 'ding' });
      ctx.emit({ kind: 'display', prop: 't_score', text: `${ctx.text.labels!.score}\n${s.score}` });
      ctx.emit({ kind: 'status', text: `${ctx.text.labels!.score}: ${s.score}` });
      ctx.emit({ kind: 'scale', prop: 't_balloon', scale: 0 });
      s.pumps = undefined;
      s.nextAt = ctx.now() + 0.6;
    }
  },

  tick(ctx, t) {
    if (ctx.state.nextAt !== undefined && t >= Number(ctx.state.nextAt)) {
      ctx.state.nextAt = undefined;
      next(ctx);
    }
  },

  onLeave(ctx) {
    ctx.emit({ kind: 'status', text: null });
  },

  score(ev, { params }) {
    const done = balloonsOf(ev);
    const banked = done.filter((x) => x.outcome === 'bank');
    const collapsed = done.filter((x) => x.outcome === 'collapse');
    const afterLoss: number[] = [], afterBank: number[] = [];
    for (let i = 1; i < done.length; i++) (done[i - 1]!.outcome === 'collapse' ? afterLoss : afterBank).push(done[i]!.pumps);
    const shift = afterLoss.length && afterBank.length ? mean(afterLoss)! - mean(afterBank)! : null;
    // Hesitation curve: time between presses against pump number, pooled across balloons.
    const points: [number, number][] = [];
    const pumps = of(ev, 'pump');
    for (let i = 1; i < pumps.length; i++) {
      const a = pumps[i - 1]!, b = pumps[i]!;
      if (a.data.vein === b.data.vein) points.push([Number(b.data.pumps), b.t - a.t]);
    }
    const avg = mean(banked.map((x) => x.pumps));
    const metrics = {
      balloons: done.length,
      adjusted_avg_pumps: r2(avg),
      collapse_rate: done.length ? r2(collapsed.length / done.length) : null,
      post_loss_shift: r2(shift),
      hesitation_curve: points.length >= 4 ? r2(slope(points)) : null,
      party_score: banked.reduce((a, x) => a + x.pumps, 0) * (Number(params.value) || 1),
      // How many the player chose to start (the office version is open-ended): logged as its own metric.
      voluntary_repetitions: of(ev, 'vein_start').filter((v) => of(ev, 'pump').some((p) => p.data.vein === v.data.vein)).length,
    };
    const notes: string[] = [];
    if (!done.length) notes.push('You left the party without blowing up a single balloon.');
    else {
      notes.push(`You blew up ${done.length} balloon${done.length === 1 ? '' : 's'}${avg !== null ? `, pumping ${Math.round(avg)} times on average before tying one off` : ''}.`);
      if (collapsed.length) notes.push(`${collapsed.length} popped in your hands.`);
      if (shift !== null && Math.abs(shift) >= 2) notes.push(shift > 0 ? 'Right after a pop, you pumped harder.' : 'After a pop, you played it safer.');
    }
    return { metrics, notes };
  },

  profile(m, adjust) {
    const avg = m.adjusted_avg_pumps;
    if (avg === null || avg === undefined) return;
    if (avg >= 14) adjust('impulsivity', 0.1, `pumped party balloons ${Math.round(avg)} times on average`);
    else if (avg <= 6) adjust('impulsivity', -0.06, 'tied the balloons off early');
  },
};

/** Start the next balloon, or finish when the pack is empty. */
function next(ctx: ModuleCtx) {
  const s = ctx.state;
  const n = Number(s.balloon ?? 0) + 1;
  if (n > (Number(ctx.p.balloons) || 10)) {
    s.done = true;
    s.toldDone = true;
    ctx.emit({ kind: 'scale', prop: 't_balloon', scale: 0 });
    ctx.say('done');
    return;
  }
  s.balloon = n;
  s.pumps = 0;
  s.breakAt = breakPoint(ctx.rng('breaks'), Number(ctx.p.maxPumps) || 32);
  ctx.log('vein_start', { vein: n, breakAt: s.breakAt });
  ctx.emit({ kind: 'scale', prop: 't_balloon', scale: size(0) });
}

/** The hidden break point: uniform on 1..max, one draw per balloon from the task's own seeded stream. */
function breakPoint(rng: Rng, max: number): number {
  return randInt(rng, 1, max);
}

function size(pumps: number) {
  return Math.round((0.35 + pumps * 0.05) * 1000) / 1000;
}

/** Each finished balloon: how many pumps, and whether it was banked or popped. Unfinished ones don't count. */
export function balloonsOf(ev: { type: string; data: Record<string, unknown> }[]): { vein: number; pumps: number; outcome: 'bank' | 'collapse' }[] {
  return ev
    .filter((e) => e.type === 'bank' || e.type === 'collapse')
    .map((e) => ({ vein: Number(e.data.vein), pumps: Number(e.data.pumps), outcome: e.type as 'bank' | 'collapse' }));
}
