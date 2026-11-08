import { pick } from '../../util/random';
import type { TestKind } from '../types';
import { up } from './shared';

/** Every exit is locked until the player inspects a few things. Needs rooms with things to inspect. */
export const unlock: TestKind = {
  id: 'inspect_to_unlock',
  measures: [{ trait: 'curiosity', a: 6, b: 0.5 }, { trait: 'impulsivity', a: 6, b: 0.5 }],
  candidates: (['waiting_room', 'open_office', 'hub', 'l_gallery', 'u_gallery', 'corridor'] as const).map((archetype) => ({ archetype, exits: [1, 3] as [number, number], weight: archetype === 'corridor' ? 0.5 : 1 })),
  weight: (t) => 1 + 4 * up(t.impulsivity) + 2 * up(1 - t.curiosity),
  params: ({ rng }) => ({ count: rng() < 0.5 ? 2 : 3 }),
  describe: (p) => `Every exit is locked until the player inspects ${p.count} things. "rule_line" is said on entry and hints at this; "rule_done_line" is said when the doors unlock. Make the inspect texts worth reading.`,
  start(h, _t, history) {
    const inspectable = h.room.props.filter((p) => h.data.props.find((r) => r.id === p.recipe)?.inspectable).length + (h.room.anomaly ? 1 : 0);
    h.state.need = Math.min(Number(h.rule.params.count), inspectable);
    h.state.seen = new Set(history.flatMap((e) => {
      if (!('roomId' in e) || e.roomId !== h.room.id) return [];
      if (e.type === 'inspected') return [e.objectId];
      if (e.type === 'anomaly_action' && e.action === 'use' && e.anomalyId === h.room.anomaly?.id) return [`anomaly:${e.anomalyId}`];
      return [];
    }));
    h.state.open = (h.state.seen as Set<string>).size >= Number(h.state.need);
    if (Number(h.state.need) > 0 && !h.state.open) {
      h.emit({ kind: 'doors', locked: h.exits });
      h.say(h.rule.line);
    }
  },
  onEvent(h, e) {
    if (h.state.open) return;
    const seen = h.state.seen as Set<string>;
    if (e.type === 'inspected' || (e.type === 'anomaly_action' && e.action === 'use' && e.anomalyId === h.room.anomaly?.id)) {
      seen.add(e.type === 'inspected' ? e.objectId : `anomaly:${e.anomalyId}`);
      if (seen.size >= Number(h.state.need)) {
        h.state.open = true;
        h.emit({ kind: 'doors', locked: [] });
        h.say(h.rule.doneLine);
      }
    } else if (e.type === 'door_tried') {
      if (!h.state.tried) h.profile.adjust('impulsivity', 0.08, 'tried a locked door before looking around', h.room, e.t);
      h.state.tried = true;
      h.say(pick(h.rng, h.data.templates.rules.inspect_to_unlock?.tried ?? ['Not yet.']));
    }
  },
};
