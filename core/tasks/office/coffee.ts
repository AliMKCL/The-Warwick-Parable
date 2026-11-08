import { Builder } from '../../room/layouts';
import { cells, onWall } from '../layouts';
import { createRng, deriveSeed } from '../../util/random';
import type { OfficeTaskModule } from './module';
import { of, r2, slope } from './util';

/**
 * 7. Three Coffee Machines (office version of the Three Tunnels): learning from outcomes vs trusting advice.
 *
 * The Iowa Gambling Task (Bechara et al., 1994) with three options. The
 * narrator recommends one machine; it is secretly the bad one: big boosts but
 * frequent large spills, net negative. The other two give smaller boosts and
 * come out ahead. Payoffs are fixed, pre-shuffled sequences per option, as in
 * the original task, so every player meets the same outcomes. Which position
 * (left, middle, right) holds the recommended machine is shuffled per session.
 * Open-ended: 0 to `maxPicks` coffees.
 */

/** Per option, the nth coffee's (gain, loss), repeating every 10. Net over 10: bad -250, good +250. */
export const PAYOFFS = {
  bad: { gain: 100, losses: { 3: 150, 5: 300, 7: 200, 9: 250, 10: 350 } as Record<number, number> },
  steady: { gain: 50, losses: { 3: 50, 5: 50, 7: 50, 9: 50, 10: 50 } as Record<number, number> },
  rare: { gain: 50, losses: { 10: 250 } as Record<number, number> },
};
type Kind = keyof typeof PAYOFFS;
const LABELS = ['A', 'B', 'C'];

export function payoff(kind: Kind, nth: number): { gain: number; loss: number } {
  const p = PAYOFFS[kind];
  return { gain: p.gain, loss: p.losses[((nth - 1) % 10) + 1] ?? 0 };
}

export const coffee: OfficeTaskModule = {
  id: 'coffee',
  number: '7',
  needs: {
    fixtures: [
      { id: 't_machine1', recipe: 'coffee_machine', what: 'machine A (left): pressing it pours a coffee' },
      { id: 't_machine2', recipe: 'coffee_machine', what: 'machine B (middle)' },
      { id: 't_machine3', recipe: 'coffee_machine', what: 'machine C (right)' },
    ],
    zones: [{ id: 'machines', what: 'in front of the machines' }],
    doors: 'one exit, always open',
  },

  defaults(seed) {
    const rng = createRng(deriveSeed(seed, 'coffee-machines'));
    const recommended = Math.floor(rng() * 3); // 0, 1, 2: which position holds the (bad) recommended machine
    const goodFirst = rng() < 0.5;
    const kinds: Kind[] = [0, 1, 2].map((i) => (i === recommended ? 'bad' : '' as Kind));
    let g = goodFirst ? ['steady', 'rare'] : ['rare', 'steady'];
    for (let i = 0; i < 3; i++) if (!kinds[i]) kinds[i] = g.shift() as Kind;
    return { recommended, kinds: kinds.join(','), maxPicks: 12, energy: 50 };
  },

  layout(_p, rng, data) {
    const W = 8, D = 7;
    const t = data.tasks.office.coffee;
    const b = new Builder('break_room', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(4);
    const exit = b.door('e', 4, { label: t.labels!.exit });
    [2, 4, 6].forEach((x, i) => {
      b.fixture({ id: `t_machine${i + 1}`, recipe: 'coffee_machine', x, z: 0.33, face: 's', y: 0, surfaceText: `${LABELS[i]}\nREADY` });
    });
    b.fixture({ id: 't_sign', recipe: 'sign_wall', ...onWall('n', 4, W, D, 0.03), y: 2.35, surfaceText: t.labels!.sign, inspectText: t.labels!.sign });
    b.reserve(cells(1, 0, 7, 1));
    b.zone({ id: 'machines', x: 4, z: 1.4, r: 2.6 });
    b.wallSlots();
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    const rec = LABELS[Number(ctx.p.recommended)]!;
    ctx.state.energy = Number(ctx.p.energy) || 50;
    ctx.state.picks = 0;
    ctx.state.n = [0, 0, 0];
    ctx.say('advice', ctx.text.lines.advice!.replaceAll('{machine}', rec));
    ctx.log('advice', { recommended: rec, position: Number(ctx.p.recommended) });
    ctx.emit({ kind: 'status', text: `${ctx.text.labels!.energy}: ${ctx.state.energy}` });
  },

  onEvent(ctx, e) {
    if (e.type !== 'pressed') return;
    const i = ['t_machine1', 't_machine2', 't_machine3'].indexOf(e.objectId);
    if (i < 0) return;
    const s = ctx.state;
    const max = Number(ctx.p.maxPicks) || 12;
    if (Number(s.picks) >= max) {
      if (!s.toldEmpty) { s.toldEmpty = true; ctx.say('empty'); }
      return;
    }
    const kinds = String(ctx.p.kinds).split(',') as Kind[];
    const n = s.n as number[];
    n[i]! += 1;
    s.picks = Number(s.picks) + 1;
    const { gain, loss } = payoff(kinds[i]!, n[i]!);
    s.energy = Number(s.energy) + gain - loss;
    const label = LABELS[i]!;
    ctx.log('interact', { object: e.objectId, action: 'pour' });
    ctx.log('choice', { prompt: 'machine', chosen: label, position: i, pick: s.picks, recommended: i === Number(ctx.p.recommended) });
    ctx.log('outcome', { machine: label, gain, loss, net: gain - loss });
    ctx.emit({ kind: 'sound', name: loss ? 'spill' : 'pour' });
    ctx.emit({ kind: 'display', prop: e.objectId, text: loss ? `${label}\n+${gain}  SPILL -${loss}` : `${label}\n+${gain}` });
    ctx.emit({ kind: 'status', text: `${ctx.text.labels!.energy}: ${s.energy}` });
    if (loss && !s.toldSpill) { s.toldSpill = true; ctx.say('spill'); }
    if (Number(s.picks) >= max) {
      for (let k = 0; k < 3; k++) ctx.emit({ kind: 'display', prop: `t_machine${k + 1}`, text: `${LABELS[k]}\n${ctx.text.labels!.empty}` });
    }
  },

  onLeave(ctx) {
    ctx.emit({ kind: 'status', text: null });
  },

  score(ev) {
    const picks = of(ev, 'choice', (d) => d.prompt === 'machine');
    const outs = of(ev, 'outcome');
    const rec = (e: (typeof picks)[number]) => e.data.recommended === true;
    // Net score per block of 5: good picks minus recommended (bad) picks.
    const blocks: number[] = [];
    for (let b = 0; b + 5 <= picks.length; b += 5) {
      const block = picks.slice(b, b + 5);
      blocks.push(block.filter((p) => !rec(p)).length - block.filter(rec).length);
    }
    const last = picks.slice(-5);
    let lossN = 0, shift = 0, winN = 0, stay = 0;
    for (let i = 1; i < picks.length; i++) {
      const lost = Number(outs[i - 1]?.data.loss ?? 0) > 0;
      const same = picks[i]!.data.chosen === picks[i - 1]!.data.chosen;
      if (lost) { lossN++; if (!same) shift++; } else { winN++; if (same) stay++; }
    }
    const metrics = {
      picks: picks.length,
      net_score: outs.reduce((a, o) => a + Number(o.data.net), 0),
      net_per_block: blocks.length ? blocks.reduce((a, b) => a + b, 0) / blocks.length : null,
      learning_slope: blocks.length >= 2 ? r2(slope(blocks.map((v, i) => [i + 1, v] as [number, number]))) : null,
      advice_reliance: last.length >= 5 ? r2(last.filter(rec).length / last.length) : null,
      lose_shift_rate: lossN ? r2(shift / lossN) : null,
      win_stay_rate: winN ? r2(stay / winN) : null,
      voluntary_repetitions: picks.length,
    };
    const notes: string[] = [];
    if (!picks.length) notes.push('You walked past the coffee machines.');
    else {
      const recN = picks.filter(rec).length;
      notes.push(`You had ${picks.length} coffee${picks.length === 1 ? '' : 's'}, ${recN} of them from the machine you were told was the good one.`);
      if (metrics.advice_reliance !== null) notes.push(metrics.advice_reliance >= 0.6 ? 'By the end you were still using it, spills and all.' : 'By the end you had mostly moved on from it.');
    }
    return { metrics, notes };
  },

  profile(m, adjust) {
    if (m.advice_reliance === null || m.advice_reliance === undefined) return;
    if (m.advice_reliance >= 0.6) adjust('compliance', 0.08, 'kept using the recommended coffee machine despite the spills');
    else if (m.advice_reliance <= 0.2) adjust('compliance', -0.06, 'abandoned the recommended coffee machine');
  },
};
