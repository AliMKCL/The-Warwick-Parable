import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import { compareSelf, findPatterns, measure } from '../../core/director/selfcheck';
import type { CoreMessage, Measured, RuleEffect, SelfTrait } from '../../core/protocol';
import { createCore } from '../../core/run/core';
import { gamblePlan, Run } from '../../core/run/run';
import { RuleRuntime, type RoomRule } from '../../core/rules/rules';
import { createRng } from '../../core/util/random';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exits = (run: Run) => run.current!.layout.doors.filter((d) => !d.entrance);

/** Plays from room 0 into the first gamble room (room 1). */
async function toGamble(seed: number, runLength = 7) {
  const run = new Run(seed, gameData, { observeMs: 0, runLength });
  run.start();
  await run.next(exits(run)[0]!.id);
  return run;
}

/** Finds a seed whose first gamble lands on `outcome` if the 50/50 door is taken. */
async function seedFor(outcome: 'shortcut' | 'setback') {
  for (let seed = 1; seed < 200; seed++) {
    const run = await toGamble(seed);
    if (run.current!.rule?.params.outcome === outcome) return run;
  }
  throw new Error('no seed found');
}

describe('gamble rooms', () => {
  it('puts three gambles in a default run, spread out, never adjacent, the middle one timed', () => {
    expect([...gamblePlan(6)]).toEqual([[1, { timed: false }], [3, { timed: true }], [5, { timed: false }]]);
    expect([...gamblePlan(4).keys()]).toEqual([1, 3]);
    expect(gamblePlan(3).size).toBe(0); // runs of four rooms or fewer have none
  });

  it('offers two doors, tagged CERTAIN and 50/50, with the stakes spelled out', async () => {
    const run = await toGamble(11);
    const room = run.current!;
    expect(room.rule?.id).toBe('gamble');
    expect(exits(run)).toHaveLength(2);
    const { safe, risky, stakes, outcome } = room.rule!.params;
    expect(room.layout.doors.find((d) => d.id === safe)!.label).toMatch(/CERTAIN$/);
    expect(room.layout.doors.find((d) => d.id === risky)!.label).toMatch(/50\/50$/);
    expect(String(stakes)).toMatch(/CERTAIN/);
    expect(String(stakes)).toMatch(/50\/50/);
    expect(['shortcut', 'setback']).toContain(outcome);
    expect(room.narrator.doors[String(risky)]).toBeTruthy();
  });

  it('the certain door gives the next room as planned, with its task', async () => {
    const run = await toGamble(11);
    const safe = String(run.current!.rule!.params.safe);
    const next = await run.next(safe);
    expect(next.gambleResult).toBeUndefined();
    expect(next.rule).toBeDefined(); // behind a gamble there is always a task
    expect(run.gambles).toEqual([{ room: 1, choice: 'safe', outcome: 'certain', timed: false, expired: false }]);
    expect(run.last).toBe(6);
  });

  it('a won 50/50 skips the next room’s task; a lost one adds a detour room', async () => {
    const win = await seedFor('shortcut');
    const a = await win.next(String(win.current!.rule!.params.risky));
    expect(a.gambleResult).toBe('shortcut');
    expect(a.rule).toBeUndefined();
    expect(win.last).toBe(6);

    const lose = await seedFor('setback');
    const b = await lose.next(String(lose.current!.rule!.params.risky));
    expect(b.gambleResult).toBe('setback');
    expect(lose.last).toBe(7);
    expect(lose.gambles[0]).toMatchObject({ choice: 'risky', outcome: 'setback' });
  });

  it('the timed gamble locks the 50/50 door when the clock runs out', async () => {
    const run = await toGamble(11);
    const effects: RuleEffect[] = [];
    const said: string[] = [];
    const rule: RoomRule = { id: 'gamble', params: { safe: 'd1', risky: 'd2', seconds: 0.05, outcome: 'setback', stakes: 'The stakes.' }, line: 'x', doneLine: 'Too late.' };
    const rt = new RuleRuntime(rule, { room: run.current!, profile: run.profile, emit: (e) => effects.push(e), say: (s) => said.push(s), rng: createRng(1), data: gameData });
    rt.start(0);
    expect(said[0]).toBe('The stakes.');
    expect(effects[0]).toMatchObject({ kind: 'timer', seconds: 0.05 });
    await sleep(90);
    expect(effects).toContainEqual({ kind: 'doors', locked: ['d2'] });
    expect(said.at(-1)).toBe('Too late.');
  });

  it('announces the coin toss, and a won gamble before the last room ends the run early', async () => {
    const core = createCore(gameData, { observeMs: 0, runLength: 5 });
    const msgs: CoreMessage[] = [];
    core.onMessage((m) => msgs.push(m));
    // Find a seed whose last gamble (room 3 of 0..4) is a shortcut, then always take the 50/50 door.
    let seed = 1;
    for (; seed < 300; seed++) {
      const r = new Run(seed, gameData, { observeMs: 0, runLength: 5 });
      r.start();
      for (let i = 0; i < 3; i++) await r.next(r.current!.rule?.id === 'gamble' ? String(r.current!.rule.params.safe) : r.current!.layout.doors.find((d) => !d.entrance)!.id);
      if (r.current!.rule?.params.outcome === 'shortcut') break;
    }
    core.send({ type: 'run_started', seed, t: 0, selfRatings: { risk: 1, patience: 3, social: 3, exploration: 3 } });
    let t = 0;
    for (let i = 0; i < 4 && !msgs.some((m) => m.type === 'run_ended'); i++) {
      const room = core.run()!.current!;
      core.send({ type: 'room_entered', roomId: room.id, t: (t += 1) });
      await sleep(10);
      const door = room.rule?.id === 'gamble' && room.index === 3 ? String(room.rule.params.risky) : room.rule?.id === 'gamble' ? String(room.rule.params.safe) : room.layout.doors.find((d) => !d.entrance)!.id;
      core.send({ type: 'door_chosen', roomId: room.id, doorId: door, t: (t += 10) });
      await sleep(30);
    }
    await sleep(50);
    const end = msgs.find((m) => m.type === 'run_ended') as Extract<CoreMessage, { type: 'run_ended' }>;
    expect(end).toBeDefined();
    expect(end.dossier.rooms).toHaveLength(4); // the last room was skipped
    expect(end.dossier.gambles.at(-1)).toMatchObject({ room: 3, choice: 'risky', outcome: 'shortcut' });
    expect(msgs.some((m) => m.type === 'narrator_line' && /straight to your file/.test(m.text))).toBe(true);
    expect(end.dossier.saidDid?.rows.find((r) => r.trait === 'risk')?.said).toBe(1);
  });
});

const m = (score: number, evidence = 'x', estimated = false): Measured => ({ score, evidence, n: 3, estimated });
const all = (o: Partial<Record<SelfTrait, Measured>>) => ({ risk: m(3), patience: m(3), social: m(3), exploration: m(3), ...o });

describe('you said / you did', () => {
  it('headlines the single biggest gap', () => {
    const sd = compareSelf(all({ risk: m(1, 'You chose the certain door every time.'), patience: m(2) }), { risk: 5, patience: 4, social: 3, exploration: 3 });
    expect(sd.headline).toBe('You said you take risks. You chose the certain door every time.');
    expect(sd.headlineTrait).toBe('risk');
    expect(sd.detail).toBe('You said 5/5. You did 1/5.');
    expect(sd.rows.find((r) => r.trait === 'patience')!.gap).toBe(2);
  });

  it('says so honestly when every gap is small, and never headlines an estimate', () => {
    const calm = compareSelf(all({ risk: m(4) }), { risk: 5, patience: 3, social: 2, exploration: 4 });
    expect(calm.headline).toBe('You know yourself well.');
    expect(calm.headlineTrait).toBeNull();
    const est = compareSelf(all({ social: m(1, 'Estimated.', true) }), { risk: 3, patience: 3, social: 5, exploration: 3 });
    expect(est.headlineTrait).toBeNull();
  });

  it('phrases an underestimate the other way', () => {
    const sd = compareSelf(all({ exploration: m(4.6, 'You inspected 9 of the 10 things you could have.') }), { risk: 3, patience: 3, social: 3, exploration: 1 });
    expect(sd.headline).toBe("You said you don't explore much. You inspected 9 of the 10 things you could have.");
  });

  it('measures patience from countdowns, with a concrete line', () => {
    const run = new Run(3, gameData, { observeMs: 60_000 });
    run.start();
    // Four countdown rooms: waited out one, left early from three.
    for (let i = 0; i < 4; i++) {
      const room = { ...run.current!, id: `timer-${i}`, index: i + 1, rule: { id: 'exit_timer' as const, params: { seconds: 30 }, line: '', doneLine: '' } };
      run.rooms.push(room);
      run.ruleStarts.set(room.id, i * 100);
      run.events.push({ type: 'room_entered', roomId: room.id, t: i * 100 }, { type: 'door_chosen', roomId: room.id, doorId: 'd1', t: i * 100 + (i === 0 ? 31 : 5) });
    }
    const p = measure(run, gameData).patience;
    expect(p.evidence).toBe('You left before 3 of 4 countdowns ended.');
    expect(Math.round(p.score)).toBe(2);
  });
});

describe('contradictions', () => {
  it('turns hesitant-and-impulsive into one sentence about when each shows', () => {
    const run = new Run(3, gameData, { observeMs: 60_000 });
    const r0 = run.start();
    const ruled = { ...r0, id: 'r1', index: 1, rule: { id: 'inspect_to_unlock' as const, params: { count: 2 }, line: '', doneLine: '' } };
    const free = { ...r0, id: 'r2', index: 2 };
    run.rooms.push(ruled, free);
    run.profile.adjust('hesitation', 0.2, 'waited in the locked room', ruled, 1);
    run.profile.adjust('impulsivity', 0.2, 'left the open room at once', free, 2);
    expect(findPatterns(run)).toEqual([{ traits: ['hesitation', 'impulsivity'], sentence: "You wait when the building makes you, and rush when it doesn't." }]);
  });

  it('finds no pattern when traits do not conflict', () => {
    const run = new Run(3, gameData, { observeMs: 60_000 });
    run.start();
    run.profile.traits.hesitation = 0.8;
    run.profile.traits.impulsivity = 0.3;
    expect(findPatterns(run)).toEqual([]);
  });
});
