import { randInt } from '../../util/random';
import type { TestHandle, TestKind } from '../types';
import { ORDINARY, up } from './shared';

/** A countdown; when it ends, every exit but one locks (the one the player paid least attention to). */
export const countdown: TestKind = {
  id: 'exit_timer',
  candidates: ORDINARY.map((archetype) => ({ archetype, exits: [2, 3] as [number, number] })),
  weight: (t) => 1 + 4 * up(t.hesitation),
  params: ({ rng }) => ({ seconds: randInt(rng, 25, 40) }),
  describe: (p) => `A countdown of ${p.seconds} s starts on entry. When it ends, all exits but one lock. "rule_line" announces the countdown; "rule_done_line" is said when it runs out.`,
  start(h, t) {
    const seconds = Number(h.rule.params.seconds);
    h.emit({ kind: 'timer', seconds, label: 'Doors close in' });
    h.say(h.rule.line);
    h.state.startedAt = t;
    h.after('expire', seconds, () => expire(h));
  },
  onEvent(h, e) {
    if (e.type === 'door_chosen' && !h.state.expired) {
      const used = e.t - Number(h.state.startedAt ?? e.t);
      if (used < Number(h.rule.params.seconds) / 3) h.profile.adjust('impulsivity', 0.07, `left ${Math.round(used)} s into the countdown`, h.room, e.t);
    } else if (e.type === 'door_hovered') {
      h.state.hovered = { ...(h.state.hovered as object), [e.doorId]: true };
    }
  },
  borrowTime(h, t, seconds) {
    if (h.state.expired || h.state.borrowed || h.state.startedAt === undefined) return false;
    const remaining = Number(h.state.startedAt) + Number(h.rule.params.seconds) - t;
    if (remaining <= 0) return false;
    h.state.borrowed = true;
    h.state.borrowedSeconds = seconds;
    h.after('expire', remaining + seconds, () => expire(h));
    h.emit({ kind: 'timer', seconds: remaining + seconds, label: 'Doors close in' });
    return true;
  },
};

function expire(h: TestHandle) {
  h.state.expired = true;
  const hovered = (h.state.hovered ?? {}) as Record<string, boolean>;
  // Keep open the door they paid least attention to.
  const keep = h.exits.find((id) => !hovered[id]) ?? h.exits[0]!;
  h.emit({ kind: 'timer', seconds: null, label: '' });
  h.emit({ kind: 'doors', locked: h.exits.filter((id) => id !== keep) });
  h.profile.adjust('hesitation', 0.14, 'let the countdown run out', h.room, Number(h.state.startedAt ?? 0) + Number(h.rule.params.seconds) + Number(h.state.borrowedSeconds ?? 0));
  h.say(h.rule.doneLine);
}
