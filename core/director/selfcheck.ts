import type { Evidence, GameEvent, Measured, Pattern, SaidDid, SelfRatings, SelfTrait, TaskMeasure, TaskResult, TraitName } from '../protocol';
import type { GameData, RoomSpec } from '../room/types';
import type { Run } from '../run/run';
import { combine, scoreTaskResults } from './taskscore';

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

/** The tasks' results this run: rescored at the end when the run can (office-tasks' Run.finalTaskResults), else as reported. */
export function taskResultsOf(run: Run): TaskResult[] {
  const r = run as unknown as { finalTaskResults?: () => TaskResult[]; taskResults?: TaskResult[] };
  return r.finalTaskResults?.() ?? r.taskResults ?? [];
}

/**
 * The four self-rated traits, 1–5. With no task results this is exactly the
 * score from the ordinary signals (gambles, countdowns, the button, inspecting).
 * Once tasks have reported, each trait is the weighted average of every
 * measurement this run: ordinary signals weigh 1, tasks their own weight
 * (core/director/taskscore.ts).
 */
export function measure(run: Run, data: GameData): Record<SelfTrait, Measured> {
  const results = taskResultsOf(run);
  if (!results.length) return measureOrdinary(run, data).measured;
  return withTasks(run, data, scoreTaskResults(results));
}

/** Combines the ordinary signals with task measurements. Exported for tests. */
export function withTasks(run: Run, data: GameData, measures: readonly TaskMeasure[]): Record<SelfTrait, Measured> {
  // Rooms a task already scores for curiosity (the desk) aren't counted again as ordinary rooms.
  const taskRooms = new Set(measures.filter((x) => x.trait === 'exploration').map((x) => x.room));
  const { measured, shares } = measureOrdinary(run, data, taskRooms);
  const out = {} as Record<SelfTrait, Measured>;
  for (const k of SELF_TRAITS) {
    const m = measured[k];
    const tasks = measures.filter((x) => x.trait === k && x.counts);
    const ordinary = m.estimated ? null : shares[k];
    const c = combine(ordinary, m.n, tasks);
    if (!c) {
      // No measurement at all (still an estimate), or ordinary signals only.
      out[k] = m.estimated ? m : { ...m, ...(m.n === 1 ? { oneObservation: true } : {}) };
      continue;
    }
    // A single moment is one observation unless it is graded (a time, a share); ordinary signals are yes/no.
    const one = c.n === 1 && !(tasks.length === 1 && ordinary === null && tasks[0]!.graded);
    out[k] = {
      score: scale(c.share),
      evidence: ordinary !== null ? m.evidence : tasks[0]!.evidence,
      n: c.n,
      estimated: false,
      ...(tasks.length ? { tasks } : {}),
      ...(tasks.length && ordinary !== null ? { ordinaryShare: ordinary } : {}),
      ...(one ? { oneObservation: true } : {}),
    };
  }
  return out;
}

/** The ordinary signals only, with each tested trait's share (0..1) for combining with tasks. */
function measureOrdinary(run: Run, data: GameData, skipRooms: ReadonlySet<number> = new Set()): { measured: Record<SelfTrait, Measured>; shares: Record<SelfTrait, number | null> } {
  const shares: Record<SelfTrait, number | null> = { risk: null, patience: null, social: null, exploration: null };
  const t = run.profile.traits;
  const estimate = (v: number, evidence: string): Measured => ({ score: scale(v), evidence, n: 0, estimated: true });

  // Risk: the gamble doors.
  const g = run.gambles;
  const risky = g.filter((x) => x.choice === 'risky').length;
  const expired = g.filter((x) => x.expired).length;
  const risk: Measured = g.length
    ? {
        score: scale((shares.risk = risky / g.length)),
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
      score: scale((shares.patience = (n - left) / n)),
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
    // No countdown means patience was never put to the test: only an estimate, never a headline.
    if (stays.length) {
      const avg = stays.reduce((a, b) => a + b, 0) / stays.length;
      // 8 s a room reads as 1/5, a minute or more as 5/5.
      patience = { score: scale((avg - 8) / 52), n: 0, estimated: true, evidence: `No countdown this run. Rough estimate from your ${Math.round(avg)} s per room.` };
    } else patience = estimate(t.hesitation, 'No countdown this run. Rough estimate from how long you hesitated.');
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
    social = { score: scale((shares.social = (pressed + followed) / nSocial)), n: nSocial, estimated: false, evidence: `You ${parts.join(' and ')}.` };
  } else social = estimate(t.compliance, 'Estimated from how you responded to instructions.');

  // Exploration: in how many of the rooms you entered you inspected anything. Per room, so a room
  // full of desks can't swamp the score. Only rooms you entered count (never ones planned behind
  // doors you didn't take), only things placed on purpose count (not filler furniture), and rooms
  // that required inspecting to open their doors are left out.
  const { roomsSeen, rooms, objectsSeen, objects, forced } = explorationCounts(run, data, skipRooms);
  const exploration: Measured = rooms
    ? {
        score: scale((shares.exploration = roomsSeen / rooms)),
        n: rooms,
        estimated: false,
        evidence:
          (roomsSeen === 0
            ? `You didn't inspect anything in any of the ${rooms} room${rooms > 1 ? 's' : ''} you entered (${objects} object${objects > 1 ? 's were' : ' was'} there).`
            : `You inspected something in ${roomsSeen} of ${rooms} room${rooms > 1 ? 's' : ''} you entered (${objectsSeen} of ${objects} object${objects > 1 ? 's' : ''}).`) +
          (forced ? ` Rooms that required inspecting aren't counted.` : ''),
      }
    : estimate(t.curiosity, 'Nothing to inspect freely this run. Rough estimate from what you looked at.');

  return { measured: { risk, patience, social, exploration }, shares };
}

/** Props worth inspecting: placed on purpose, inspectable, not the button, and with something to read. */
export function pointsOfInterest(room: RoomSpec, data: GameData) {
  return room.props.filter((p) => {
    const r = data.props.find((x) => x.id === p.recipe);
    return p.featured && !!r?.inspectable && r.interact !== 'button' && !!(p.inspectText || p.surfaceText);
  });
}

/** What the exploration score is built from. Exported for tests. */
export function explorationCounts(run: Run, data: GameData, skipRooms: ReadonlySet<number> = new Set()) {
  const entered = run.rooms.filter((r) => !skipRooms.has(r.index) && eventsIn(run, r).some((e) => e.type === 'room_entered'));
  const free = entered.filter((r) => r.rule?.id !== 'inspect_to_unlock');
  const counted = free.filter((r) => pointsOfInterest(r, data).length > 0);
  let roomsSeen = 0, objectsSeen = 0, objects = 0;
  for (const r of counted) {
    const poi = new Set(pointsOfInterest(r, data).map((p) => p.id));
    const inspected = new Set(eventsIn(run, r).flatMap((e) => (e.type === 'inspected' ? [e.objectId] : [])));
    objects += poi.size;
    objectsSeen += [...inspected].filter((id) => poi.has(id)).length;
    if (inspected.size) roomsSeen++;
  }
  return { roomsSeen, rooms: counted.length, objectsSeen, objects, forced: entered.length - free.length };
}

/**
 * The evidence line that supports a score in one direction: with several
 * sources (ordinary signals and tasks), the lowest-scoring one when the point
 * is "less than you said", the highest when it is "more". So the line quoted
 * never argues against the claim it backs. With one source, its own line.
 */
export function evidenceToward(m: Measured, high: boolean): string {
  if (!m.tasks?.length) return m.evidence;
  const sources = [...(m.ordinaryShare !== undefined ? [{ value: m.ordinaryShare, evidence: m.evidence }] : []), ...m.tasks];
  return sources.reduce((a, b) => (high ? b.value > a.value : b.value < a.value) ? b : a).evidence;
}

/** Puts the player's ratings next to what they did, and finds the one gap worth a headline. */
export function compareSelf(measured: Record<SelfTrait, Measured>, ratings: SelfRatings): SaidDid {
  const rows = SELF_TRAITS.map((trait) => {
    const m = measured[trait];
    const said = ratings[trait] ?? null;
    // Untested: no "did" and no gap, only an estimate shown in grey. It can never be the headline or a red gap.
    const did = m.estimated ? null : Math.round(m.score);
    // One yes/no moment: shown, but never a gap or the headline.
    const gap = said === null || did === null || m.oneObservation ? null : said - did;
    return { trait, label: SELF_LABELS[trait], said, did, estimate: Math.round(m.score), gap, evidence: m.evidence, estimated: m.estimated, ...(m.oneObservation ? { oneObservation: true } : {}) };
  });
  const big = rows
    .filter((r) => r.gap !== null && !r.estimated && Math.abs(r.gap) >= BIG_GAP)
    .sort((a, b) => Math.abs(b.gap!) - Math.abs(a.gap!) || measured[b.trait].n - measured[a.trait].n)[0];
  if (!big) {
    const rated = rows.filter((r) => r.said !== null && !r.estimated && !r.oneObservation);
    const single = rows.some((r) => r.said !== null && r.oneObservation);
    return {
      rows,
      headline: rated.length ? 'You know yourself well.' : 'There was not enough to compare.',
      detail: rated.length
        ? `Every rating you gave was within a point of what you did${rated.length < rows.length ? ' (where the building could measure it)' : ''}.`
        : single
          ? 'Where the building tested you, it saw each thing only once: too little to hold against you.'
          : 'The building could not test what you rated yourself on this time.',
      headlineTrait: null,
    };
  }
  const said = big.said!;
  const evidence = evidenceToward(measured[big.trait], big.gap! < 0);
  const [pos, neg] = CLAIMS[big.trait];
  const claim = big.gap! > 0
    ? said >= 4 ? `You said you ${pos}.` : `You rated yourself ${said}/5 on "${big.label}".`
    : said <= 2 ? `You said you ${neg}.` : `You rated yourself ${said}/5 on "${big.label}".`;
  return {
    rows,
    headline: `${claim} ${evidence}`,
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

/**
 * Words in a verdict's name or summary that claim a trait is high or low.
 * Used to catch a title like "The Patient Applicant" on a player measured 1/5 for patience.
 */
const CLAIM_WORDS: Record<SelfTrait, { high: RegExp; low: RegExp }> = {
  patience: { high: /\bpatien(t|ce)\b|\bwait(ed|s|ing)?\b|took (your|their) time|\blinger/i, low: /impatien|\bhurr(y|ied)|\brush(ed|es|ing)?\b|\bhast(e|y)/i },
  risk: { high: /gambl|\brisk(s|y)?\b|\bbold\b|daring|reckless/i, low: /\bcautio|\bcareful|\bsafe\b|\bcertain\b/i },
  social: { high: /obedien|complian|did (as|what) (you were|it was) told|model employee|\bfollow(ed|s)?\b/i, low: /defian|contrar|rebel|disobe/i },
  exploration: { high: /curio|\bread(s|er|ing)?\b|explor|inspect|every memo/i, low: /incurious|shortcut|ignored (the|every) detail/i },
};

/** Names from the measured behaviour: [low, high]. */
const MEASURED_NAMES: Record<SelfTrait, [string, string]> = {
  risk: ['The Safe Bet', 'The Gambler'],
  patience: ['The Hurried Applicant', 'The Patient Applicant'],
  social: ['The Contrarian', 'The Model Employee'],
  exploration: ['The Shortcut', 'The Reader'],
};

/** Which tested traits a piece of text contradicts. */
export function conflicts(text: string, measured: Record<SelfTrait, Measured>): SelfTrait[] {
  return SELF_TRAITS.filter((k) => {
    const m = measured[k];
    if (m.estimated) return false;
    const s = Math.round(m.score);
    return (s <= 2 && CLAIM_WORDS[k].high.test(text)) || (s >= 4 && CLAIM_WORDS[k].low.test(text));
  });
}

/** A name and summary built only from the measured, tested scores. */
export function measuredTitle(measured: Record<SelfTrait, Measured>): { name: string; summary: string } {
  const tested = SELF_TRAITS.filter((k) => !measured[k].estimated && !measured[k].oneObservation)
    .map((k) => ({ k, d: measured[k].score - 3 }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const top = tested[0];
  const name = !top || Math.abs(top.d) < 1 ? 'The Unremarkable Applicant' : MEASURED_NAMES[top.k][top.d > 0 ? 1 : 0];
  const lines = tested.filter((x) => Math.abs(x.d) >= 1).slice(0, 2).map((x) => evidenceToward(measured[x.k], x.d > 0));
  const summary = lines.length
    ? `${lines.join(' ')} The building has adjusted itself accordingly.`
    : 'You did nothing the building could hold against you. That, too, has been noted.';
  return { name, summary };
}

/**
 * Makes the verdict's name and summary agree with the measured scores (and so
 * with "you said / you did"). If either claims something a tested score
 * contradicts, both are rewritten from the measured scores. Returns what it found.
 */
export function alignVerdict<V extends { name: string; summary: string }>(verdict: V, measured: Record<SelfTrait, Measured>): { verdict: V; conflicts: SelfTrait[] } {
  const found = [...new Set([...conflicts(verdict.name, measured), ...conflicts(verdict.summary, measured)])];
  if (!found.length) return { verdict, conflicts: [] };
  return { verdict: { ...verdict, ...measuredTitle(measured) }, conflicts: found };
}
