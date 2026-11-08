import { Builder } from '../../room/layouts';
import { pick } from '../../util/random';
import { against, cells, onWall } from '../layouts';
import { median } from '../metrics';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { of, r2 } from './util';

/**
 * 9. The Renumbered Floor (office version of the Chalk Arrows): adaptability when rules change.
 *
 * The Wisconsin Card Sorting Test as a walk. The player looks for meeting
 * room 4.12 through a run of junctions, each with three ways on (left, ahead,
 * right) and three cues that always disagree a little: the wall sign, a
 * colleague pointing, and the floor plan. At first the signs are right.
 * After `switchAt` junctions a screen flickers "Floor renumbered this
 * weekend", and from then on the signs mislead while the colleagues are
 * right. A wrong turn loops back to the same junction with a small time cost.
 *
 * In this placeholder the "junction" is one room the player is walked back
 * into each time (a fade); a real layout can make them separate rooms, as
 * long as each junction logs the same events.
 */
export const DIRS = ['left', 'ahead', 'right'] as const;
type Dir = (typeof DIRS)[number];
const ARROW: Record<Dir, string> = { left: '←', ahead: '↑', right: '→' };
const OPENING: Record<Dir, string> = { left: 't_left', ahead: 't_ahead', right: 't_right' };

export const renumbered: OfficeTaskModule = {
  id: 'renumbered',
  number: '9',
  needs: {
    fixtures: [
      { id: 't_left', recipe: 'corridor_opening', what: 'the way on to the left (pressing it walks into it)' },
      { id: 't_ahead', recipe: 'corridor_opening', what: 'the way on straight ahead' },
      { id: 't_right', recipe: 'corridor_opening', what: 'the way on to the right' },
      { id: 't_sign', recipe: 'sign_wall', what: 'wall sign: an arrow towards 4.12' },
      { id: 't_pointer', recipe: 'colleague_pointing', what: 'a colleague who turns to point one way' },
      { id: 't_map', recipe: 'memo_board', what: 'floor plan with an arrow' },
      { id: 't_notice', recipe: 'notice_screen', what: 'a screen that flickers the renumbering notice' },
    ],
    zones: [],
    doors: 'the real exit (room 4.12) stays locked until the last junction is passed',
  },

  defaults: () => ({ junctions: 7, switchAt: 4, timeout: 240 }),

  layout(_p, rng, data) {
    const W = 9, D = 8;
    const t = data.tasks.office.renumbered;
    const b = new Builder('junction', W, D, 2.8, { rng, doorLabels: [] });
    const ex = b.entrance(4);
    const exit = b.door('s', 7, { label: t.labels!.room });
    b.fixture({ id: 't_left', recipe: 'corridor_opening', ...against('w', 3, W, D, 0.3), y: 0 }, cells(0, 2, 0, 4));
    b.fixture({ id: 't_ahead', recipe: 'corridor_opening', ...against('n', 4.5, W, D, 0.3), y: 0 }, cells(3, 0, 5, 0));
    b.fixture({ id: 't_right', recipe: 'corridor_opening', ...against('e', 3, W, D, 0.3), y: 0 }, cells(W - 1, 2, W - 1, 4));
    b.fixture({ id: 't_sign', recipe: 'sign_wall', ...onWall('n', 6.9, W, D, 0.03), y: 2.0, surfaceText: '4.12', inspectText: t.labels!.signInspect });
    b.fixture({ id: 't_pointer', recipe: 'colleague_pointing', x: 4.5, z: 3.7, face: 's', y: 0 });
    b.fixture({ id: 't_map', recipe: 'memo_board', ...onWall('w', 5.6, W, D, 0.03), y: 1.5, surfaceText: t.labels!.map, inspectText: t.labels!.mapInspect });
    b.fixture({ id: 't_notice', recipe: 'notice_screen', ...onWall('e', 5.6, W, D, 0.05), y: 1.7, surfaceText: t.labels!.welcome });
    b.reserve(cells(0, 5, 0, 6));
    b.reserve(cells(W - 1, 5, W - 1, 6));
    b.wallSlots(['wall_mounted']);
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    const n = Number(ctx.p.junctions) || 7;
    const sw = Number(ctx.p.switchAt) || 4;
    const rng = ctx.rng('junctions');
    const others = (d: Dir) => DIRS.filter((x) => x !== d);
    // The whole route is drawn up front, so a looped-back junction shows the same cues again.
    ctx.state.route = Array.from({ length: n }, (_, i) => {
      const correct = pick(rng, DIRS);
      const before = i < sw;
      return {
        correct,
        signs: before ? correct : pick(rng, others(correct)),
        colleague: before ? pick(rng, others(correct)) : correct,
        map: pick(rng, DIRS),
        rule: before ? 'signs' : 'colleague',
      };
    });
    ctx.state.j = 0;
    ctx.emit({ kind: 'doors', locked: ctx.exits() });
    ctx.say('intro');
    show(ctx);
  },

  onEvent(ctx, e) {
    if (e.type !== 'pressed' || ctx.state.done) return;
    const dir = (Object.keys(OPENING) as Dir[]).find((d) => OPENING[d] === e.objectId);
    if (!dir || ctx.now() < Number(ctx.state.readyAt ?? 0)) return;
    const j = Number(ctx.state.j);
    const route = ctx.state.route as { correct: Dir; signs: Dir; colleague: Dir; map: Dir; rule: string }[];
    const junction = route[j]!;
    const correct = dir === junction.correct;
    ctx.log('interact', { object: e.objectId, action: 'walk' });
    ctx.log('choice', {
      prompt: `junction${j + 1}`, junction: j + 1, chosen: dir, correct, rule: junction.rule,
      followed: { signs: dir === junction.signs, colleague: dir === junction.colleague, map: dir === junction.map },
      decision: r2(ctx.now() - Number(ctx.state.shownAt)),
    });
    ctx.log('outcome', { junction: j + 1, correct, looped: !correct });
    const spawn = ctx.room.layout.spawn;
    if (correct) {
      ctx.state.j = j + 1;
      if (j + 1 >= route.length) return arrive(ctx, 'arrived');
      ctx.emit({ kind: 'teleport', x: spawn.x, z: spawn.z, yaw: spawn.yaw, dark: 0.7 });
      show(ctx, 0.7);
    } else {
      // A wrong turn comes back round to the same junction, a little later.
      ctx.emit({ kind: 'teleport', x: spawn.x, z: spawn.z, yaw: spawn.yaw, dark: 2.5 });
      show(ctx, 2.5);
    }
  },

  tick(ctx, t) {
    if (!ctx.state.done && t - ctx.t0() >= (Number(ctx.p.timeout) || 240)) arrive(ctx, 'giveup');
  },

  score(ev, { params }) {
    const sw = Number(params.switchAt) || 4;
    const choices = of(ev, 'choice', (d) => String(d.prompt).startsWith('junction'));
    const pre = choices.filter((c) => Number(c.data.junction) <= sw);
    const post = choices.filter((c) => Number(c.data.junction) > sw);
    // Perseverative errors: after the switch, following the signs again once they have already misled.
    let misledOnce = false, persev = 0;
    for (const c of post) {
      const f = c.data.followed as { signs: boolean };
      if (f.signs && !c.data.correct) {
        if (misledOnce) persev++;
        misledOnce = true;
      }
    }
    // Junctions to adapt: choices after the switch until three correct in a row.
    let run = 0, toAdapt: number | null = null;
    post.forEach((c, i) => {
      run = c.data.correct ? run + 1 : 0;
      if (run === 3 && toAdapt === null) toAdapt = i + 1;
    });
    const dt = (cs: typeof choices) => median(cs.map((c) => Number(c.data.decision)).filter((x) => Number.isFinite(x)));
    const before = dt(pre), after = dt(post);
    const metrics = {
      junctions: of(ev, 'outcome', (d) => d.correct === true).length,
      pre_switch_accuracy: pre.length ? r2(pre.filter((c) => c.data.correct).length / pre.length) : null,
      perseverative_errors: post.length ? persev : null,
      junctions_to_adapt: toAdapt,
      decision_time_change: before && after ? r2(after / before) : null,
    };
    const notes: string[] = [];
    if (!choices.length) notes.push('You never set off looking for room 4.12.');
    else {
      const wrong = choices.filter((c) => !c.data.correct).length;
      notes.push(`Finding room 4.12 took you ${choices.length} turn${choices.length === 1 ? '' : 's'}, ${wrong} of them wrong.`);
      if (post.length) notes.push(toAdapt !== null ? `After the floor was renumbered you were back on track within ${toAdapt} turns.` : 'After the floor was renumbered, you never quite found your bearings.');
      if (persev) notes.push(`You trusted the old signs ${persev} more time${persev === 1 ? '' : 's'} after they had already misled you.`);
    }
    return { metrics, notes };
  },

  profile(m, adjust) {
    if ((m.perseverative_errors ?? 0) >= 2) adjust('hesitation', 0.06, 'kept following the old signs after the floor was renumbered');
  },
};

/** Show the current junction's cues (after `delay` seconds of walking back in). */
function show(ctx: ModuleCtx, delay = 0) {
  const route = ctx.state.route as { correct: Dir; signs: Dir; colleague: Dir; map: Dir; rule: string }[];
  const j = Number(ctx.state.j);
  const junction = route[j]!;
  const sw = Number(ctx.p.switchAt) || 4;
  if (j === sw && !ctx.state.switched) {
    ctx.state.switched = true;
    ctx.log('rule_change', { junction: j + 1, reliable: 'colleague' });
    ctx.emit({ kind: 'display', prop: 't_notice', text: ctx.text.labels!.notice! });
    ctx.emit({ kind: 'sound', name: 'click' });
  }
  ctx.emit({ kind: 'display', prop: 't_sign', text: `4.12 ${ARROW[junction.signs]}` });
  ctx.emit({ kind: 'display', prop: 't_map', text: `${ctx.text.labels!.map}\n4.12 ${ARROW[junction.map]}` });
  ctx.emit({ kind: 'turn', prop: 't_pointer', at: OPENING[junction.colleague] });
  ctx.log('junction', { junction: j + 1, correct: junction.correct, cues: { signs: junction.signs, colleague: junction.colleague, map: junction.map }, rule: junction.rule });
  ctx.state.shownAt = ctx.now() + delay;
  ctx.state.readyAt = ctx.now() + delay;
}

function arrive(ctx: ModuleCtx, line: 'arrived' | 'giveup') {
  ctx.state.done = true;
  for (const id of Object.values(OPENING)) ctx.emit({ kind: 'disable', prop: id });
  ctx.emit({ kind: 'doors', locked: [] });
  ctx.log('outcome', { finished: line === 'arrived' });
  ctx.say(line);
}
