import { Builder } from '../../room/layouts';
import { cells, onWall } from '../layouts';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { mean, of, r2 } from './util';

/**
 * 10a. The Board Pitch (office version of the Cart Jump): confidence calibration.
 *
 * Each pitch is a timing challenge: stop the marker while the slide's key
 * point is in the highlighted zone. Before each one the finance director
 * asks how confident the player is (0 to 100 %). Payouts use the quadratic
 * (Brier) rule, 100 x (1 - (o - p)^2), so stating your true belief pays
 * best on average and exaggerating can't. After the first pitch the board
 * asks whether anyone else wants to present, so the player chooses how many
 * to give (0 to `maxPitches`).
 */
export const brierPoints = (p: number, made: boolean) => Math.round(100 * (1 - ((made ? 1 : 0) - p) ** 2));

export const pitch: OfficeTaskModule = {
  id: 'pitch',
  number: '10a',
  needs: {
    fixtures: [
      { id: 't_lectern', recipe: 'lectern', what: 'where the player stands to pitch (pressing it starts a pitch)' },
      { id: 't_screen', recipe: 'projector_screen', what: 'the slide and the payouts' },
      { id: 't_table', recipe: 'table_long', what: 'the board table' },
    ],
    zones: [],
    doors: 'one exit, always open',
  },

  defaults: () => ({ zoneWidth: 0.2, speed: 0.55, maxPitches: 5 }),

  layout(_p, rng, data) {
    const W = 10, D = 9;
    const t = data.tasks.office.pitch;
    const b = new Builder('boardroom', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(5);
    const exit = b.door('e', 6, { label: t.labels!.exit });
    b.fixture({ id: 't_screen', recipe: 'projector_screen', ...onWall('n', 5, W, D, 0.04), y: 1.8, surfaceText: t.labels!.slide });
    b.fixture({ id: 't_lectern', recipe: 'lectern', x: 7.4, z: 1.6, face: 's', y: 0 }, cells(6, 0, 8, 2));
    b.fixture({ id: 't_table', recipe: 'table_long', x: 4.5, z: 4.5, face: 's', y: 0 }, cells(2, 3, 7, 6));
    // The board: three seated members around the table, facing it.
    b.fixture({ id: 't_board1', recipe: 'worker_seated', x: 3.0, z: 5.65, face: 'n', y: 0 });
    b.fixture({ id: 't_board2', recipe: 'worker_seated_b', x: 5.0, z: 5.65, face: 'n', y: 0 });
    b.fixture({ id: 't_board3', recipe: 'worker_seated_c', x: 4.0, z: 3.35, face: 's', y: 0 });
    b.reserve(cells(1, 0, 9, 1));
    b.wallSlots();
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    ctx.state.n = 0;
    ctx.state.total = 0;
    ctx.say('intro');
  },

  onEvent(ctx, e) {
    const s = ctx.state;
    if (e.type === 'pressed' && e.objectId === 't_lectern') {
      if (s.busy || s.done) return;
      if (Number(s.n) >= (Number(ctx.p.maxPitches) || 5)) return;
      if (Number(s.n) > 0 && !s.asked) return;
      startPitch(ctx);
      return;
    }
    if (e.type !== 'answer') return;
    const n = Number(s.n);
    if (e.askId === `conf${n}`) {
      const p = e.value / 100;
      s.p = p;
      ctx.log('choice', { prompt: `conf${n}`, pitch: n, p: r2(p), seconds: r2(e.seconds) });
      const half = (Number(ctx.p.zoneWidth) || 0.2) / 2;
      const centre = 0.5;
      s.zone = [centre - half, centre + half];
      ctx.ask({ id: `pitch${n}`, mode: 'meter', title: ctx.text.labels!.meterTitle!, text: ctx.text.labels!.meterText, speed: Number(ctx.p.speed) || 0.55, zone: s.zone as [number, number] });
    } else if (e.askId === `pitch${n}`) {
      const [a, b] = s.zone as [number, number];
      const made = e.value >= a && e.value <= b;
      const p = Number(s.p);
      const points = brierPoints(p, made);
      s.total = Number(s.total) + points;
      ctx.log('outcome', { pitch: n, made, p: r2(p), error: r2(Math.abs(e.value - (a + b) / 2)), points });
      ctx.emit({ kind: 'sound', name: made ? 'ding' : 'clunk' });
      ctx.emit({ kind: 'display', prop: 't_screen', text: `${made ? ctx.text.labels!.landed : ctx.text.labels!.missed}\n${ctx.text.labels!.payout} ${points}` });
      ctx.say(made ? `made${n}` : `fell${n}`, made ? ctx.text.lines.made : ctx.text.lines.fell);
      s.busy = false;
      if (n < (Number(ctx.p.maxPitches) || 5)) {
        s.asked = true;
        ctx.ask({ id: `more${n}`, mode: 'choice', title: ctx.text.labels!.moreTitle!, options: [ctx.text.labels!.again!, ctx.text.labels!.sit!] });
      } else {
        s.done = true;
      }
    } else if (e.askId === `more${n}`) {
      ctx.log('choice', { prompt: `more${n}`, chosen: e.value === 0 ? 'again' : 'sit' });
      if (e.value === 0) startPitch(ctx);
      else {
        s.done = true;
        ctx.emit({ kind: 'disable', prop: 't_lectern' });
        ctx.say('sat');
      }
    }
  },

  score(ev) {
    const outs = of(ev, 'outcome', (d) => d.pitch !== undefined);
    const ps = outs.map((o) => Number(o.data.p));
    const os: number[] = outs.map((o) => (o.data.made ? 1 : 0));
    const afterFall: number[] = [], afterSuccess: number[] = [];
    for (let i = 1; i < outs.length; i++) (os[i - 1] ? afterSuccess : afterFall).push(ps[i]!);
    const meanP = mean(ps), success = os.length ? os.reduce((a, b) => a + b, 0) / os.length : null;
    const metrics = {
      pitches: outs.length,
      mean_confidence: r2(meanP),
      success_rate: r2(success),
      overconfidence: meanP !== null && success !== null ? r2(meanP - success) : null,
      brier: outs.length ? r2(ps.reduce((a, p, i) => a + (p - os[i]!) ** 2, 0) / outs.length) : null,
      confidence_after_fall: afterFall.length && afterSuccess.length ? r2(mean(afterFall)! - mean(afterSuccess)!) : null,
      points: outs.reduce((a, o) => a + Number(o.data.points), 0),
      voluntary_repetitions: outs.length,
    };
    const notes: string[] = [];
    if (!outs.length) notes.push('You let someone else do the pitching.');
    else {
      notes.push(`You gave ${outs.length} pitch${outs.length === 1 ? '' : 'es'}, landing ${os.filter(Boolean).length}, and said you were on average ${Math.round(meanP! * 100)}% sure.`);
      if (metrics.overconfidence !== null && Math.abs(metrics.overconfidence) >= 0.2) notes.push(metrics.overconfidence > 0 ? 'You expected to land more than you did.' : 'You landed more than you expected to.');
    }
    return { metrics, notes };
  },

  profile(m, adjust) {
    if ((m.overconfidence ?? 0) >= 0.3) adjust('impulsivity', 0.06, 'was more confident in the pitch than it went');
    else if ((m.overconfidence ?? 0) <= -0.3) adjust('hesitation', 0.06, 'expected the pitch to go worse than it did');
  },
};

function startPitch(ctx: ModuleCtx) {
  const s = ctx.state;
  s.n = Number(s.n) + 1;
  s.busy = true;
  s.asked = false;
  ctx.emit({ kind: 'display', prop: 't_screen', text: `${ctx.text.labels!.slide}\n${s.n}` });
  ctx.ask({ id: `conf${s.n}`, mode: 'slider', title: ctx.text.labels!.confTitle!, text: ctx.text.labels!.confText, min: 0, max: 100, step: 5, value: 50, unit: '%' });
}
