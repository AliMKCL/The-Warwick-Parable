import type { Evidence, GameEvent, Measured, Pattern, SaidDid, SelfRatings, SelfTrait, TraitName } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';
import type { Run } from '../run/run';

/**
 * "You said / you did": the player's behaviour on the four traits they rated
 * themselves on at the start (risk, patience, social, exploration), measured
 * on the same 1–5 scale from what actually happened, each with one concrete
 * line of evidence. Only real tests count; when a run had none for a trait,
 * the score is marked as an estimate and never used for the headline.
 */

export const SELF_TRAITS: SelfTrait[] = ['risk', 'patience', 'social', 'exploration'];

/** The statements on the start screen, in the player's words. */
export const SELF_LABELS: Record<SelfTrait, string> = {
  risk: 'I take risks',
  patience: 'I am patient',
  social: "I do what I'm told",
  exploration: 'I explore everything',
};

/** How to say each claim back: [what a high rating claims, what a low rating claims]. */
const CLAIMS: Record<SelfTrait, [string, string]> = {
  risk: ['take risks', "don't take risks"],
  patience: ['are patient', "aren't patient"],
  social: ["do what you're told", "don't do what you're told"],
  exploration: ['explore everything', "don't explore much"],
};

/** A gap of this many points (on 1–5) or more is worth a headline. */
const BIG_GAP = 2;

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** A share (0..1) on the 1–5 scale. */
const scale = (share: number) => round1(1 + 4 * clamp01(share));
const times = (k: number) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`);

function eventsIn(run: Run, room: RoomSpec): GameEvent[] {
  return run.events.filter((e) => 'roomId' in e && e.roomId === room.id);
}
function chosen(run: Run, room: RoomSpec) {
  const e = eventsIn(run, room).find((x) => x.type === 'door_chosen');
  return e?.type === 'door_chosen' ? e : undefined;
}

export function measure(run: Run, data: GameData): Record<SelfTrait, Measured> {
  const t = run.profile.traits;
  const estimate = (v: number, evidence: string): Measured => ({ score: scale(v), evidence, n: 0, estimated: true });

  // Risk: the gamble doors.
  const g = run.gambles;
  const risky = g.filter((x) => x.choice === 'risky').length;
  const expired = g.filter((x) => x.expired).length;
  const risk: Measured = g.length
    ? {
        score: scale(risky / g.length),
        n: g.length,
        estimated: false,
        evidence:
          (risky === 0
            ? g.length === 1 ? 'You chose the certain door.' : 'You chose the certain door every time.'
            : risky === g.length
              ? g.length === 1 ? 'You took the 50/50 door.' : 'You took the 50/50 door every time.'
              : `You took the 50/50 door ${risky} of ${g.length} times.`) +
          (expired ? ` You let the clock run out ${times(expired)}.` : ''),
      }
    : estimate(t.impulsivity, 'No gambles this run; estimated from how quickly you acted.');

  // Patience: countdowns waited out, or failing that, time spent in each room.
  const timerRooms = run.rooms.filter((r) => r.rule?.id === 'exit_timer' && chosen(run, r));
  let patience: Measured;
  if (timerRooms.length) {
    const left = timerRooms.filter((r) => {
      const start = run.ruleStarts.get(r.id);
      return start === undefined || chosen(run, r)!.t - start < Number(r.rule!.params.seconds) - 0.25;
    }).length;
    const n = timerRooms.length;
    patience = {
      score: scale((n - left) / n),
      n,
      estimated: false,
      evidence:
        left === 0 ? (n === 1 ? 'You waited out the countdown.' : `You waited out all ${n} countdowns.`)
        : left === n ? (n === 1 ? 'You left before the countdown ended.' : `You left before all ${n} countdowns ended.`)
        : `You left before ${left} of ${n} countdowns ended.`,
    };
  } else {
    const stays = run.rooms
      .map((r) => {
        const entered = eventsIn(run, r).find((e) => e.type === 'room_entered')?.t;
        const out = chosen(run, r)?.t;
        return entered === undefined || out === undefined ? undefined : out - entered;
      })
      .filter((x): x is number => x !== undefined);
    if (stays.length) {
      const avg = stays.reduce((a, b) => a + b, 0) / stays.length;
      // 8 s a room reads as 1/5, a minute or more as 5/5.
      patience = { score: scale((avg - 8) / 52), n: stays.length, estimated: false, evidence: `No countdowns this run; you spent ${Math.round(avg)} s in each room on average.` };
    } else patience = estimate(t.hesitation, 'Estimated from how long you hesitated.');
  }

  // Social: the button in the first room, and the narrator's recommendations.
  const isButton = (recipe: string) => data.props.find((p) => p.id === recipe)?.interact === 'button';
  const buttonRooms = run.rooms.filter((r) => r.props.some((p) => isButton(p.recipe)) && chosen(run, r));
  const pressed = buttonRooms.filter((r) => eventsIn(run, r).some((e) => e.type === 'pressed')).length;
  const suggestRooms = run.rooms.filter((r) => r.rule?.id === 'narrator_suggests' && r.rule.params.door && chosen(run, r));
  const followed = suggestRooms.filter((r) => chosen(run, r)!.doorId === r.rule!.params.door).length;
  const nSocial = buttonRooms.length + suggestRooms.length;
  let social: Measured;
  if (nSocial) {
    const parts: string[] = [];
    if (buttonRooms.length) parts.push(pressed === buttonRooms.length ? 'pressed the button' : pressed === 0 ? 'never pressed the button' : `pressed the button in ${pressed} of ${buttonRooms.length} rooms`);
    if (suggestRooms.length) {
      const m = suggestRooms.length;
      parts.push(followed === m ? (m === 1 ? "took the narrator's recommended door" : "took the narrator's door every time") : followed === 0 ? (m === 1 ? "ignored the narrator's recommended door" : "ignored the narrator's door every time") : `took the narrator's door ${followed} of ${m} times`);
    }
    social = { score: scale((pressed + followed) / nSocial), n: nSocial, estimated: false, evidence: `You ${parts.join(' and ')}.` };
  } else social = estimate(t.compliance, 'Estimated from how you responded to instructions.');

  // Exploration: how much of what could be inspected was.
  const inspectable = (recipe: string) => {
    const r = data.props.find((p) => p.id === recipe);
    return !!r?.inspectable && r.interact !== 'button';
  };
  let total = 0, seen = 0;
  for (const r of run.rooms) {
    if (!eventsIn(run, r).some((e) => e.type === 'room_entered')) continue;
    const ids = new Set(r.props.filter((p) => inspectable(p.recipe)).map((p) => p.id));
    total += ids.size;
    seen += new Set(eventsIn(run, r).flatMap((e) => (e.type === 'inspected' && ids.has(e.objectId) ? [e.objectId] : []))).size;
  }
  const exploration: Measured = total
    ? { score: scale(seen / total), n: total, estimated: false, evidence: seen === 0 ? `You didn't inspect a single thing (${total} were there to look at).` : `You inspected ${seen} of the ${total} things you could have.` }
    : estimate(t.curiosity, 'Estimated from what you looked at.');

  return { risk, patience, social, exploration };
}

/** Puts the player's ratings next to what they did, and finds the one gap worth a headline. */
export function compareSelf(measured: Record<SelfTrait, Measured>, ratings: SelfRatings): SaidDid {
  const rows = SELF_TRAITS.map((trait) => {
    const m = measured[trait];
    const said = ratings[trait] ?? null;
    const did = Math.round(m.score);
    return { trait, label: SELF_LABELS[trait], said, did, gap: said === null ? null : said - did, evidence: m.evidence, estimated: m.estimated };
  });
  // Only measured traits can make the headline: an estimate is not evidence of a gap.
  const big = rows
    .filter((r) => r.gap !== null && !r.estimated && Math.abs(r.gap) >= BIG_GAP)
    .sort((a, b) => Math.abs(b.gap!) - Math.abs(a.gap!) || measured[b.trait].n - measured[a.trait].n)[0];
  if (!big) {
    const rated = rows.filter((r) => r.said !== null && !r.estimated);
    return {
      rows,
      headline: rated.length ? 'You know yourself well.' : 'There was not enough to compare.',
      detail: rated.length
        ? `Every rating you gave was within a point of what you did${rated.length < rows.length ? ' (where the building could measure it)' : ''}.`
        : 'The building could not test what you rated yourself on this time.',
      headlineTrait: null,
    };
  }
  const said = big.said!;
  const [pos, neg] = CLAIMS[big.trait];
  const claim = big.gap! > 0
    ? said >= 4 ? `You said you ${pos}.` : `You rated yourself ${said}/5 on "${big.label}".`
    : said <= 2 ? `You said you ${neg}.` : `You rated yourself ${said}/5 on "${big.label}".`;
  return {
    rows,
    headline: `${claim} ${big.evidence}`,
    detail: `You said ${said}/5. You did ${big.did}/5.`,
    headlineTrait: big.trait,
  };
}

/**
 * Hidden traits that point opposite ways (hesitant and impulsive; curious and
 * impulsive) are not shown as two labels. The evidence says when each showed,
 * and that becomes one sentence describing the actual pattern.
 */
export function findPatterns(run: Run): Pattern[] {
  const t = run.profile.traits;
  const high = (k: TraitName) => t[k] >= 0.62;
  const ev = (k: TraitName) => run.profile.evidence.filter((e) => e.trait === k && e.delta > 0);
  const ruled = new Set(run.rooms.filter((r) => r.rule).map((r) => r.index));
  /** Share of a trait's positive evidence that came from rooms with a rule (timer, locks, gambles…). */
  const inRuled = (xs: Evidence[]) => share(xs, (e) => ruled.has(e.room));
  const meanRoom = (xs: Evidence[]) => {
    const w = xs.reduce((a, e) => a + e.delta, 0);
    return w ? xs.reduce((a, e) => a + e.room * e.delta, 0) / w : 0;
  };
  const out: Pattern[] = [];

  if (high('hesitation') && high('impulsivity')) {
    const h = ev('hesitation'), i = ev('impulsivity');
    const hr = inRuled(h), ir = inRuled(i);
    let sentence: string;
    if (hr >= 0.6 && ir <= 0.4) sentence = "You wait when the building makes you, and rush when it doesn't.";
    else if (ir >= 0.6 && hr <= 0.4) sentence = 'You rush when the building pushes you, and take your time when it leaves you alone.';
    else if (meanRoom(h) + 1 <= meanRoom(i)) sentence = 'You started out cautious, then sped up the deeper you went.';
    else if (meanRoom(i) + 1 <= meanRoom(h)) sentence = 'You rushed at first, then slowed down the deeper you went.';
    else sentence = 'You hesitate for a long time, then act all at once.';
    out.push({ traits: ['hesitation', 'impulsivity'], sentence });
  }
  if (high('curiosity') && high('impulsivity') && !out.some((p) => p.traits.includes('impulsivity'))) {
    const c = ev('curiosity');
    const forced = share(c, (e) => run.rooms[e.room]?.rule?.id === 'inspect_to_unlock');
    out.push({
      traits: ['curiosity', 'impulsivity'],
      sentence: forced >= 0.6
        ? "You read when the building insists, and act on instinct when it doesn't."
        : "You look at everything, then act before you've finished thinking about it.",
    });
  }
  return out;
}

function share(xs: Evidence[], pred: (e: Evidence) => boolean): number {
  const total = xs.reduce((a, e) => a + Math.abs(e.delta), 0);
  return total ? xs.filter(pred).reduce((a, e) => a + Math.abs(e.delta), 0) / total : 0;
}
