import { LIFT } from '../../room/layouts';
import { pick, randInt } from '../../util/random';
import type { TestKind } from '../types';

/**
 * A lift lobby: the lift never comes; the only way on is a MAINTENANCE door in
 * a side wall. Mashing the call button reads as impulsive, finding the door
 * alone as decisive, waiting for the hint as hesitant.
 */
export const lift: TestKind = {
  id: 'lift_wait',
  measures: [{ trait: 'hesitation', a: 6, b: 0.6 }, { trait: 'impulsivity', a: 4, b: 0.6 }, { trait: 'compliance', a: 3, b: 0.5 }],
  candidates: [{ archetype: 'lift_lobby' }],
  weight: (t) => (t.hesitation > 0.6 ? 1.6 : 1),
  maxPerRun: 1,
  setPiece: true,
  params: ({ layout, rng }) => ({ door: layout.doors.find((d) => !d.entrance)?.id ?? 'd1', hintSeconds: randInt(rng, 45, 70) }),
  describe: (p) => `This is a lift lobby. A lift with a floor indicator stands opposite the entrance, with a call button beside it. The lift never arrives: the indicator creeps down and stalls a floor or two away. The only way on is a plain door labelled MAINTENANCE in a side wall (${p.door}); its label is fixed. "rule_line" is said on entry and assures the player the lift is coming. "rule_done_line" is said if they are still waiting after ${p.hintSeconds} s, and hints at another way without naming the door. Do not mention the maintenance door anywhere else, but you may write on the walls about the lift.`,
  start(h, t) {
    h.say(h.rule.line);
    h.state.startedAt = t;
    h.state.presses = 0;
    // The indicator creeps down floor by floor, then hovers between the last two. It never arrives.
    let step = 0;
    const tick = () => {
      step++;
      const n = LIFT.floors.length;
      const text = step < n ? LIFT.floors[step]! : LIFT.floors[n - 1 - ((step - n + 1) % 2)]!;
      h.emit({ kind: 'display', prop: LIFT.doors, text });
      h.after('floor', step < n - 1 ? 3.5 : 5, tick);
    };
    h.after('floor', 3.5, tick);
    const hint = Number(h.rule.params.hintSeconds);
    h.after('hint', hint, () => {
      h.state.hinted = true;
      h.profile.adjust('hesitation', 0.12, `waited ${hint} s for a lift that never came`, h.room, t + hint);
      h.say(h.rule.doneLine);
    });
  },
  onEvent(h, e) {
    if (e.type === 'pressed' && e.objectId === LIFT.call) {
      const n = Number(h.state.presses ?? 0) + 1;
      h.state.presses = n;
      if (n === 3) h.say(pick(h.rng, h.data.templates.rules.lift_wait?.tried ?? ['It heard you the first time.']));
      if (n === 5) h.profile.adjust('impulsivity', 0.12, 'kept pressing the button for a lift that never came', h.room, e.t);
    } else if (e.type === 'door_chosen' && e.doorId === h.rule.params.door) {
      const waited = e.t - Number(h.state.startedAt ?? e.t);
      if (!h.state.hinted) h.profile.adjust('hesitation', -0.08, `gave up on the lift and found the maintenance door after ${Math.round(waited)} s`, h.room, e.t);
      else h.profile.adjust('compliance', 0.05, 'took the other way once the narrator hinted at it', h.room, e.t);
    }
  },
};
