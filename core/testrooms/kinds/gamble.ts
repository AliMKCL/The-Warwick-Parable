import type { GameData, RoomSpec } from '../../room/types';
import { createRng, deriveSeed, pick, type Rng } from '../../util/random';
import type { TestKind } from '../types';
import { ORDINARY } from './shared';

/** Labels drawn on a gamble room's two doors, so the stakes are visible as well as spoken. */
export const GAMBLE_LABELS = { safe: 'CERTAIN', risky: '50/50' } as const;
/** Seconds on the clock in the timed gamble. */
export const GAMBLE_SECONDS = 15;

/**
 * A gamble between a room's two exits. The first exit is CERTAIN (the next room
 * as planned); the second is a 50/50: a shortcut (the next room's task is gone)
 * or a setback (one more room in the run). The coin is tossed from the seed when
 * the room is planned, so it replays the same. The second gamble of a run is on
 * a clock that locks the 50/50 door. The next room is always a test room, so a
 * shortcut has a task to skip. (Run.settleGamble applies the outcome.)
 */
export const gamble: TestKind = {
  id: 'gamble',
  candidates: ORDINARY.map((archetype) => ({ archetype, exits: 2 })),
  maxPerRun: 3,
  needsNextTest: true,
  params: ({ layout, rng, used }) => {
    const exits = layout.doors.filter((d) => !d.entrance).map((d) => d.id);
    return { safe: exits[0]!, risky: exits[1] ?? exits[0]!, seconds: (used.gamble ?? 0) === 1 ? GAMBLE_SECONDS : 0, outcome: rng() < 0.5 ? 'shortcut' : 'setback' };
  },
  describe: (p) => `This room is a gamble between its two exits. Door ${p.safe} is CERTAIN: the next room, as planned. Door ${p.risky} is a 50/50: it either saves time (skips the next room's task) or adds a detour room.${Number(p.seconds) ? ` The player has ${p.seconds} s before the 50/50 door locks.` : ''} The narrator states these stakes separately, so "narrator_enter" should only set the scene, and "rule_line" should be a short dry remark about luck. Do not contradict the stakes.`,
  templateLines: (p, room, data, rng) => stakesLines(p, room, data, rng),
  /**
   * A gamble room states its stakes plainly, whoever wrote the rest: the two
   * door labels are tagged CERTAIN and 50/50, looking at either says what it
   * does, and the stakes line comes from templates so it can never be vague.
   */
  dress(spec, data) {
    const rule = spec.rule!;
    const rng = createRng(deriveSeed(spec.seed, 'gamble-lines'));
    const g = data.templates.gamble;
    const safe = String(rule.params.safe), risky = String(rule.params.risky);
    const { line: stakes } = stakesLines(rule.params, spec, data, rng);
    const tag = (label: string, t: string) => `${label.slice(0, 16 - t.length - 3).trim()} · ${t}`.replace(/^ · /, '');
    return {
      ...spec,
      layout: { ...spec.layout, doors: spec.layout.doors.map((d) => (d.id === safe ? { ...d, label: tag(d.label, GAMBLE_LABELS.safe) } : d.id === risky ? { ...d, label: tag(d.label, GAMBLE_LABELS.risky) } : d)) },
      narrator: { ...spec.narrator, doors: { ...spec.narrator.doors, [safe]: pick(rng, g.safeDoor), [risky]: pick(rng, g.riskyDoor) } },
      rule: { ...rule, params: { ...rule.params, stakes } },
    };
  },
  start(h, t) {
    // The stakes, always from templates; rule.line is the model's own remark and is not needed here.
    h.say(String(h.rule.params.stakes || h.rule.line));
    const seconds = Number(h.rule.params.seconds);
    if (seconds > 0) {
      h.emit({ kind: 'timer', seconds, label: '50/50 closes in' });
      h.state.startedAt = t;
      // The clock ran out: the 50/50 door locks, only the certain one is left.
      h.after('expire', seconds, () => {
        h.state.expired = true;
        h.emit({ kind: 'timer', seconds: null, label: '' });
        h.emit({ kind: 'doors', locked: [String(h.rule.params.risky)] });
        h.say(h.rule.doneLine);
      });
    }
  },
  onEvent(h, e) {
    if (e.type !== 'door_chosen') return;
    h.clear('expire');
    if (e.doorId === h.rule.params.risky) h.profile.adjust('impulsivity', 0.08, 'took the 50/50 door', h.room, e.t);
    else h.profile.adjust('impulsivity', -0.05, h.state.expired ? 'let the gamble run out and took the certain door' : 'chose the certain door over the 50/50', h.room, e.t);
  },
};

/** The stakes are always spelled out from templates, even in model-written rooms: the player must know it is a gamble. */
function stakesLines(p: Record<string, number | string>, room: RoomSpec, data: GameData, rng: Rng) {
  const lines = data.templates.rules.gamble!;
  const door = room.layout.doors.find((d) => d.id === p.door)?.label ?? '';
  const fill = (s: string) => s.replaceAll('{door}', door).replaceAll('{seconds}', String(p.seconds));
  const line = Number(p.seconds) ? pick(rng, data.templates.gamble.timedLine) : pick(rng, lines.line);
  return { line: fill(line), doneLine: fill(pick(rng, lines.done)) };
}
