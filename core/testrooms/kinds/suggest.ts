import type { TestKind } from '../types';
import { ORDINARY, up } from './shared';

/** The narrator recommends a door, and sometimes lies. Following or ignoring it moves compliance. */
export const suggest: TestKind = {
  id: 'narrator_suggests',
  candidates: ORDINARY.map((archetype) => ({ archetype, exits: [2, 3] as [number, number] })),
  weight: (t) => 1 + 3 * Math.abs(t.compliance - 0.5),
  picksDoor: true,
  params: ({ rng, profile }) => ({ door: '', lie: rng() < 0.4 + 0.4 * up(profile.traits.compliance) ? 1 : 0 }),
  describe: (p) => `The narrator recommends one exit: set "suggest_door" and use "rule_line" to recommend it.${Number(p.lie) ? ' The narrator is lying: the recommendation is self-serving, and a later room will reveal this.' : ' The advice is sincere.'}`,
  start(h) {
    h.say(h.rule.line);
  },
  onEvent(h, e) {
    if (e.type !== 'door_chosen') return;
    const followed = e.doorId === h.rule.params.door;
    const lie = Number(h.rule.params.lie) === 1;
    h.profile.adjust('compliance', followed ? 0.18 : -0.18,
      followed ? `took the door the narrator recommended${lie ? ' (the narrator was lying)' : ''}` : `ignored the narrator's recommendation${lie ? ' (it was a lie)' : ''}`,
      h.room, e.t);
  },
};
