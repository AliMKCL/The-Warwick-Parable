import { randInt } from '../../util/random';
import type { TestKind } from '../types';
import { ORDINARY, up } from './shared';

/** Lights dim when the player stands still, and come back when they move. */
export const lights: TestKind = {
  id: 'lights_dim_on_idle',
  candidates: ORDINARY.map((archetype) => ({ archetype, exits: [1, 3] as [number, number] })),
  weight: (t) => 0.8 + 3 * up(t.hesitation) + 1.5 * up(t.curiosity),
  params: ({ rng }) => ({ idleSeconds: randInt(rng, 4, 7) }),
  describe: (p) => `Lights dim when the player stands still for ${p.idleSeconds} s and come back when they move. "rule_line" is said as the lights go down.`,
  start(h, t, history) {
    // Already standing still when the rule starts? Treat it as stopping now.
    const last = [...history].reverse().find((e) => e.type === 'motion' && e.roomId === h.room.id);
    if (last?.type === 'motion' && !last.moving) lights.onEvent!(h, { type: 'motion', roomId: h.room.id, moving: false, t });
  },
  onEvent(h, e) {
    if (e.type !== 'motion') return;
    const idle = Number(h.rule.params.idleSeconds);
    if (!e.moving) {
      h.after('dim', idle, () => {
        h.state.dimmedAt = e.t + idle;
        h.emit({ kind: 'lights', level: 0.12, seconds: 4 });
        if (!h.state.said) { h.say(h.rule.line); h.state.said = true; }
      });
    } else {
      h.clear('dim');
      if (h.state.dimmedAt === undefined) return;
      const dark = e.t - Number(h.state.dimmedAt);
      if (dark > 6) h.profile.adjust('hesitation', 0.1, `stayed still in the dark for ${Math.round(dark)} s`, h.room, e.t);
      else h.profile.adjust('compliance', 0.05, 'moved as soon as the lights dimmed', h.room, e.t);
      h.state.dimmedAt = undefined;
      h.emit({ kind: 'lights', level: 1, seconds: 0.8 });
    }
  },
};
