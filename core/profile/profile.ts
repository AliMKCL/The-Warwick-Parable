import type { Evidence, GameEvent, ProfileSnapshot, TraitName } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';
import { EVIDENCE_ITEM, EVIDENCE_UNIT, TraitPosterior, type Item } from './bayes';

export const TRAITS: TraitName[] = ['hesitation', 'curiosity', 'compliance', 'impulsivity'];

/** How each trait reads in words, for the prompt and the dossier. */
export const TRAIT_WORDS: Record<TraitName, [low: string, high: string]> = {
  hesitation: ['decisive', 'hesitant: waits, lingers, stands still before acting'],
  curiosity: ['goal-driven: ignores details, heads for the exit', 'curious: reads and inspects everything'],
  compliance: ['defiant: does the opposite of what it is told', 'compliant: does what it is told'],
  impulsivity: ['careful: reads before acting', 'impulsive: acts first, presses buttons at once'],
};

/**
 * The hidden profile. Every trait starts at 0.5 and moves only on clear
 * evidence. Each change is logged with its reason, so the ending can show
 * the player exactly what was noticed.
 *
 * Underneath, each trait is a Bayesian posterior (core/profile/bayes.ts):
 * `traits` is its mean and `sd()` how unsure it still is. Evidence is read as
 * item responses, so the first clue moves a trait about as far as its nudge,
 * later ones less as the estimate firms up, and contradicting clues cancel
 * instead of see-sawing. The test scheduler uses the posterior to pick the
 * test that would teach it the most (expected information gain).
 */
export class Profile {
  traits: Record<TraitName, number> = { hesitation: 0.5, curiosity: 0.5, compliance: 0.5, impulsivity: 0.5 };
  readonly posterior: Record<TraitName, TraitPosterior> = {
    hesitation: new TraitPosterior(), curiosity: new TraitPosterior(), compliance: new TraitPosterior(), impulsivity: new TraitPosterior(),
  };
  evidence: Evidence[] = [];
  /** Per-room caps, so one room can't swing a trait too far. */
  private roomTotals = new Map<string, number>();

  constructor(private data: GameData) {}

  adjust(trait: TraitName, delta: number, reason: string, room: RoomSpec, t: number, capPerRoom = 0.3) {
    const key = `${room.id}:${trait}:${Math.sign(delta)}`;
    const used = this.roomTotals.get(key) ?? 0;
    const allowed = Math.sign(delta) * Math.min(Math.abs(delta), Math.max(0, capPerRoom - Math.abs(used)));
    if (Math.abs(allowed) < 0.005) return;
    this.roomTotals.set(key, used + allowed);
    this.respond(trait, allowed > 0 ? 1 : 0, EVIDENCE_ITEM, Math.abs(allowed) / EVIDENCE_UNIT, reason, room.index, t);
  }

  /**
   * One item response straight into the posterior: `y` is the outcome, `item`
   * its 2PL parameters, `weight` how many responses it counts as. Logged with
   * the change it made to the estimate.
   */
  respond(trait: TraitName, y: 0 | 1, item: Item, weight: number, reason: string, room: number, t: number) {
    const before = this.traits[trait];
    this.posterior[trait].observe(y, item, weight);
    this.traits[trait] = clamp(this.posterior[trait].mean());
    const shift = this.traits[trait] - before;
    // Very late evidence can move a firm estimate by less than a hundredth; it is still listed, with its direction.
    const delta = Math.abs(shift) >= 0.005 ? round(shift) : (y ? 0.01 : -0.01);
    this.evidence.push({ t: round(t), room, trait, delta, reason });
  }

  /**
   * A test ran but its outcome was middling (the countdown neither expired nor
   * was beaten early): half a "yes" and half a "no" on the test's own item.
   * That pulls the estimate towards the item's 50/50 point and makes it surer,
   * so the scheduler doesn't keep picking a test that already answered.
   * Not listed as evidence: nothing was noticed, which is the finding.
   */
  neutral(trait: TraitName, item: Item, weight = 1) {
    this.posterior[trait].observe(1, item, weight / 2);
    this.posterior[trait].observe(0, item, weight / 2);
    this.traits[trait] = clamp(this.posterior[trait].mean());
  }

  /** Posterior standard deviation per trait (0.2 before any evidence). */
  sd(): Record<TraitName, number> {
    return Object.fromEntries(TRAITS.map((k) => [k, round3(this.posterior[k].sd())])) as Record<TraitName, number>;
  }

  /** Update from one event. `events` is the full log so far (including this event). */
  observe(e: GameEvent, room: RoomSpec | undefined, events: GameEvent[]) {
    if (!room || !('roomId' in e) || e.roomId !== room.id) return;
    const mine = events.filter((x) => 'roomId' in x && x.roomId === room.id);
    const entered = mine.find((x) => x.type === 'room_entered')?.t ?? 0;
    const since = e.t - entered;
    const name = (id: string) => {
      const p = room.props.find((x) => x.id === id);
      return (this.data.props.find((r) => r.id === p?.recipe)?.name ?? 'something').toLowerCase();
    };

    switch (e.type) {
      case 'anomaly_action':
        if (e.anomalyId === room.anomaly?.id && mine.filter((x) => x.type === 'anomaly_action').length === 1)
          this.adjust('curiosity', 0.07, `investigated ${e.anomalyId.replaceAll('_', ' ')}`, room, e.t, 0.25);
        break;
      case 'pressed': {
        // Only the waiting room's button is read here; the lift button is read by its room rule.
        if (room.props.find((p) => p.id === e.objectId)?.recipe !== 'button_pedestal') break;
        const nth = mine.filter((x) => x.type === 'pressed').length;
        if (nth === 1) {
          if (since < 5) this.adjust('impulsivity', 0.25, `pressed the button ${Math.round(since)} s after arriving`, room, e.t);
          else if (since > 15) this.adjust('hesitation', 0.22, `waited ${Math.round(since)} s before pressing the button`, room, e.t);
          if (since < 5 && !mine.some((x) => x.type === 'inspected')) this.adjust('curiosity', -0.08, 'pressed before looking at anything', room, e.t);
        } else if (nth === 3) {
          this.adjust('impulsivity', 0.12, 'kept pressing the button', room, e.t);
        }
        break;
      }
      case 'inspected':
        this.adjust('curiosity', 0.07, `inspected the ${name(e.objectId)}`, room, e.t, 0.25);
        if (mine.filter((x) => x.type === 'inspected').length === 3) this.adjust('impulsivity', -0.06, 'took time to read three things', room, e.t);
        break;
      case 'looked_at':
        if (e.seconds >= 3) this.adjust('curiosity', 0.03, `stared at the ${name(e.objectId)} for ${Math.round(e.seconds)} s`, room, e.t, 0.1);
        break;
      case 'idle':
        if (e.seconds >= 6) this.adjust('hesitation', 0.08, `stood still for ${Math.round(e.seconds)} s`, room, e.t, 0.2);
        break;
      case 'door_hovered':
        this.adjust('hesitation', 0.05, 'lingered at a door', room, e.t, 0.12);
        break;
      case 'door_chosen': {
        if (since < 8) this.adjust('impulsivity', 0.1, `left the room after ${Math.round(since)} s`, room, e.t);
        else if (since > 45) this.adjust('hesitation', 0.1, `took ${Math.round(since)} s to leave the room`, room, e.t);
        const inspectable = room.props.filter((p) => this.data.props.find((r) => r.id === p.recipe)?.inspectable).length;
        if (inspectable >= 3 && !mine.some((x) => x.type === 'inspected' || x.type === 'anomaly_action')) this.adjust('curiosity', -0.1, 'left without inspecting anything', room, e.t);
        if (room.index === 0 && !mine.some((x) => x.type === 'pressed')) {
          this.adjust('compliance', -0.15, 'never pressed the button it was clearly meant to press', room, e.t);
          this.adjust('hesitation', 0.08, 'avoided the button entirely', room, e.t);
        }
        break;
      }
    }
  }

  /** Dominant traits first: the ones furthest from neutral. */
  ranked(): { trait: TraitName; value: number; words: string }[] {
    return TRAITS.map((trait) => ({ trait, value: this.traits[trait], words: describe(trait, this.traits[trait]) })).sort(
      (a, b) => Math.abs(b.value - 0.5) - Math.abs(a.value - 0.5),
    );
  }

  /** Plain-language readout for the prompt. */
  readout(): string[] {
    return this.ranked().map((r) => `${r.words} (${r.value.toFixed(2)})`);
  }

  snapshot(): ProfileSnapshot {
    return { traits: { ...this.traits }, sd: this.sd(), evidence: [...this.evidence] };
  }
}

export function describe(trait: TraitName, v: number): string {
  const [low, high] = TRAIT_WORDS[trait];
  if (v >= 0.62) return high;
  if (v <= 0.38) return low;
  return `neither ${low.split(':')[0]} nor ${high.split(':')[0]}`;
}

function clamp(v: number) {
  return Math.max(0.02, Math.min(0.98, v));
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
function round(n: number) {
  return Math.round(n * 100) / 100;
}
