import { gameData } from '../../core/data';
import { buildDossier, templateVerdict } from '../../core/director/dossier';
import type { Dossier, SelfRatings } from '../../core/protocol';
import { Run } from '../../core/run/run';

/**
 * Plays a few seeded runs to the end with scripted behaviour (no model, no
 * wall clock), and returns their dossiers. Used to prove the dossier and
 * said/did are unchanged when no task has reported a result: the output
 * captured before the task-scoring layer existed is in
 * fixtures/no-tasks-golden.json.
 */

export interface Style {
  /** Inspect every prop that can be inspected in each room. */
  inspect: boolean;
  /** Press any button found. */
  press: boolean;
  /** Seconds spent in each room before leaving (countdowns are 20–45 s). */
  stay: number;
  /** Take the 50/50 door in gambles, and the narrator's door when one is suggested. */
  risky: boolean;
  follow: boolean;
}

export const STYLES: Record<string, Style> = {
  bold: { inspect: false, press: true, stay: 4, risky: true, follow: false },
  careful: { inspect: true, press: false, stay: 70, risky: false, follow: true },
  mixed: { inspect: true, press: true, stay: 25, risky: true, follow: true },
};

export const RATINGS: SelfRatings = { risk: 5, patience: 1, social: 3, exploration: 4 };

export async function playScripted(seed: number, style: Style, ratings: SelfRatings | null = RATINGS): Promise<{ run: Run; dossier: Dossier }> {
  // The tests the golden fixture was captured with (no office tasks in the pool): no task reports.
  const run = new Run(seed, gameData, { observeMs: 60_000, waitMs: 1, layout: { pool: ['exit_timer', 'inspect_to_unlock', 'lights_dim_on_idle', 'narrator_suggests', 'gamble', 'lift_wait', 'choice'] } });
  if (ratings) run.selfRatings = ratings;
  run.start();
  let t = 0;
  let guard = 0;
  while (!run.finished && guard++ < 20) {
    const room = run.current!;
    run.record({ type: 'room_entered', roomId: room.id, t });
    run.startRule(t + 1);
    run.ruleStarts.set(room.id, t + 1);
    for (const p of room.props) {
      const recipe = gameData.props.find((r) => r.id === p.recipe);
      if (style.press && recipe?.interact === 'button') run.record({ type: 'pressed', roomId: room.id, objectId: p.id, t: t + 2 });
      if (style.inspect && recipe?.inspectable && recipe.interact !== 'button') run.record({ type: 'inspected', roomId: room.id, objectId: p.id, t: t + 2 });
    }
    const exits = room.layout.doors.filter((d) => !d.entrance);
    const rule = room.rule;
    let door = exits[0]!.id;
    if (rule?.id === 'gamble') door = String(style.risky ? rule.params.risky : rule.params.safe);
    else if (rule?.id === 'narrator_suggests' && rule.params.door) {
      const other = exits.find((d) => d.id !== rule.params.door);
      door = style.follow || !other ? String(rule.params.door) : other.id;
    }
    t += style.stay;
    run.record({ type: 'door_chosen', roomId: room.id, doorId: door, t });
    await run.next(door);
    t += 1;
  }
  const room = run.current!;
  run.record({ type: 'room_entered', roomId: room.id, t });
  return { run, dossier: buildDossier(run, templateVerdict(run), 'template', gameData) };
}

/** The parts of a dossier the scoring layer could touch, as plain JSON. */
export function scoringView(d: Dossier) {
  return JSON.parse(JSON.stringify({ verdict: d.verdict, measured: d.measured, saidDid: d.saidDid, verdictConflicts: d.verdictConflicts, patterns: d.patterns, gambles: d.gambles, traits: d.traits }));
}

export const GOLDEN_CASES: { seed: number; style: keyof typeof STYLES; rated: boolean }[] = [
  { seed: 11, style: 'bold', rated: true },
  { seed: 12, style: 'careful', rated: true },
  { seed: 13, style: 'mixed', rated: true },
  { seed: 14, style: 'careful', rated: false },
  { seed: 15, style: 'bold', rated: true },
  { seed: 16, style: 'mixed', rated: true },
];

export async function goldenOutput() {
  const out = [];
  for (const c of GOLDEN_CASES) {
    const { dossier } = await playScripted(c.seed, STYLES[c.style]!, c.rated ? RATINGS : null);
    out.push({ ...c, view: scoringView(dossier) });
  }
  return out;
}
