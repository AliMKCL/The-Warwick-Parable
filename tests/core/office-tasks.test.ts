import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { GameEvent, RuleEffect, TaskEvent } from '../../core/protocol';
import { orient } from '../../core/room/layouts';
import { placeAssignments } from '../../core/room/place';
import { templateAssignments } from '../../core/room/templates';
import type { RoomSpec, Side } from '../../core/room/types';
import { validateRoom } from '../../core/room/validate';
import { Run } from '../../core/run/run';
import { computeBaseline } from '../../core/tasks/metrics';
import { OFFICE_MODULES, type OfficeTaskId } from '../../core/tasks/office';
import { kOf, OFFERS } from '../../core/tasks/office/canteen';
import { PAYOFFS } from '../../core/tasks/office/coffee';
import { baseMineTrials, compareSettings, PAIRED, wantsAnother } from '../../core/tasks/paired';
import { scoreAny } from '../../core/tasks/score';
import { createRng } from '../../core/util/random';

const IDS = Object.keys(OFFICE_MODULES) as OfficeTaskId[];
const SIDES: Side[] = ['n', 's', 'e', 'w'];

describe('office task modules (tasks 6 to 11): placeholder rooms', () => {
  it('are playable in every orientation and contain everything the module needs', () => {
    for (const id of IDS)
      for (const side of SIDES)
        for (let seed = 1; seed <= 6; seed++) {
          const m = OFFICE_MODULES[id];
          const rng = createRng(seed * 101);
          const { layout: canonical } = m.layout(m.defaults(seed), rng, gameData);
          const layout = orient(canonical, side);
          const { props } = placeAssignments(layout, templateAssignments(layout, gameData, rng, { index: 1 }), gameData);
          const spec: RoomSpec = { id: 'x', index: 1, seed, layout, props, ambience: 'cold', narrator: { onEnter: '', doors: {} }, source: 'template', title: 'x' };
          const where = `${id} seed ${seed} side ${side}`;
          expect(validateRoom(spec, gameData), where).toEqual([]);
          for (const f of m.needs.fixtures) {
            const p = props.find((x) => x.id === f.id);
            expect(p, `${where}: fixture ${f.id}`).toBeTruthy();
            expect(p!.recipe, `${where}: ${f.id} recipe`).toBe(f.recipe);
            expect(gameData.props.some((r) => r.id === f.recipe), `${where}: recipe ${f.recipe} exists`).toBe(true);
          }
          for (const z of m.needs.zones) expect(layout.zones?.some((x) => x.id === z.id), `${where}: zone ${z.id}`).toBe(true);
          expect(gameData.tasks.office[id].title, `${id} has its wording in data/tasks.json`).toBeTruthy();
        }
  });
});

/** A run with one office task in room 1, and a small driver that plays it like the adapter would. */
async function play(id: OfficeTaskId, seed = 500) {
  const effects: RuleEffect[] = [];
  const said: { text: string; lineId?: string }[] = [];
  const run = new Run(seed, gameData, { observeMs: 0, tasks: true, taskOrder: [id], runLength: 3, onEffect: (e) => effects.push(e), onSay: (text, lineId) => said.push({ text, lineId }) });
  let room = run.start();
  let t = 0, x = room.layout.spawn.x, z = room.layout.spawn.z;
  const send = (e: GameEvent) => run.record(e);
  send({ type: 'room_entered', roomId: room.id, t });
  // A little baseline walking, so timing metrics have something to compare against.
  for (let i = 0; i < 40; i++) send({ type: 'move', roomId: room.id, x: x + Math.sin(i / 4), z: z - i * 0.1, t: (t += 0.1) });
  t += 1;
  send({ type: 'door_chosen', roomId: room.id, doorId: room.layout.doors.find((d) => !d.entrance)!.id, t });
  room = await run.next(room.layout.doors.find((d) => !d.entrance)!.id);
  x = room.layout.spawn.x; z = room.layout.spawn.z;
  send({ type: 'room_entered', roomId: room.id, t });
  const step = () => send({ type: 'move', roomId: room.id, x, z, t: (t = Math.round((t + 0.1) * 1000) / 1000) });
  const lastAsk = () => [...effects].reverse().find((e) => e.kind === 'ask') as Extract<RuleEffect, { kind: 'ask' }> | undefined;
  const d = {
    run, room, effects, said, get t() { return t; },
    wait(s: number) { for (let i = 0; i < s * 10; i++) step(); },
    walkTo(tx: number, tz: number) {
      const n = Math.max(1, Math.ceil(Math.hypot(tx - x, tz - z) / 0.27));
      const sx = x, sz = z;
      for (let i = 1; i <= n; i++) { x = sx + ((tx - sx) * i) / n; z = sz + ((tz - sz) * i) / n; step(); }
    },
    /** Walk up to a prop (stand in front of it). */
    goTo(propId: string, dist = 0.9) {
      const p = room.props.find((q) => q.id === propId)!;
      d.walkTo(p.x + Math.sin(p.rotY) * dist, p.z + Math.cos(p.rotY) * dist);
    },
    press(propId: string) { send({ type: 'pressed', roomId: room.id, objectId: propId, t }); },
    answer(value: number) { const a = lastAsk()!; send({ type: 'answer', roomId: room.id, askId: a.ask.id, value, seconds: 1.2, t }); },
    ask: lastAsk,
    leave() {
      const door = room.layout.doors.find((q) => !q.entrance)!;
      send({ type: 'door_chosen', roomId: room.id, doorId: door.id, t });
    },
    send,
    metrics() { return run.finalTaskResults().find((r) => r.task === id)!.metrics; },
    log(): TaskEvent[] { return run.taskLog.slice(id); },
  };
  return d;
}

describe('office task modules: scripted bots', () => {
  it('6 balloons: the risky bot pumps more, pops more, and banks less often', async () => {
    const run = async (pumps: number) => {
      const d = await play('balloons');
      d.goTo('t_pump');
      for (let b = 0; b < 10; b++) {
        for (let i = 0; i < pumps; i++) {
          if (!d.run.taskLog.slice('balloons').some((e) => e.type === 'vein_start' && e.data.vein === b + 1)) break;
          const popped = d.log().filter((e) => e.type === 'collapse').length;
          d.press('t_pump');
          d.wait(0.2);
          if (d.log().filter((e) => e.type === 'collapse').length > popped) break;
        }
        const s = d.log().filter((e) => e.type === 'vein_start').length;
        if (d.log().filter((e) => e.type === 'collapse' || e.type === 'bank').length < s) d.press('t_balloon');
        d.wait(1.2);
      }
      d.leave();
      return d.metrics();
    };
    const cautious = await run(3), risky = await run(28);
    expect(cautious.balloons).toBe(10);
    expect(risky.adjusted_avg_pumps ?? 99).toBeGreaterThan(cautious.adjusted_avg_pumps!);
    expect(risky.collapse_rate!).toBeGreaterThan(cautious.collapse_rate!);
    // Break points are hidden but logged, uniform on 1..maxPumps.
    const d = await play('balloons');
    const starts = d.log().filter((e) => e.type === 'vein_start');
    expect(starts.every((e) => Number(e.data.breakAt) >= 1 && Number(e.data.breakAt) <= 32)).toBe(true);
  });

  it('7 coffee: following the advice loses, and shows as advice reliance', async () => {
    const run = async (follow: boolean) => {
      const d = await play('coffee');
      const rec = Number(d.room.task!.params.recommended);
      const other = (rec + 1) % 3;
      for (let i = 0; i < 12; i++) { d.press(`t_machine${(follow ? rec : other) + 1}`); d.wait(0.5); }
      d.leave();
      return d.metrics();
    };
    const sheep = await run(true), learner = await run(false);
    expect(sheep.picks).toBe(12);
    expect(sheep.advice_reliance).toBe(1);
    expect(learner.advice_reliance).toBe(0);
    expect(sheep.net_score!).toBeLessThan(learner.net_score!);
    // The fixed schedules: over ten picks the recommended machine nets about -250, the others +250.
    const net = (k: keyof typeof PAYOFFS) => Array.from({ length: 10 }, (_, i) => PAYOFFS[k].gain - (PAYOFFS[k].losses[i + 1] ?? 0)).reduce((a, b) => a + b, 0);
    expect([net('bad'), net('steady'), net('rare')]).toEqual([-250, 250, 250]);
  });

  it('8 canteen: waiting, taking it now, and walking away from the queue', async () => {
    const run = async (style: 'wait' | 'now' | 'quit') => {
      const d = await play('canteen');
      for (let s = 1; s <= 4; s++) {
        const zone = d.room.layout.zones!.find((q) => q.id === `stop${s}`)!;
        d.walkTo(zone.x, zone.z);
        if (style === 'now') d.press(`t_now${s}`);
        else {
          d.press(`t_wait${s}`);
          if (style === 'wait') d.wait(32);
          else { d.wait(1); d.walkTo(d.room.layout.spawn.x, d.room.layout.spawn.z); }
        }
        d.wait(0.5);
      }
      d.leave();
      return d.metrics();
    };
    const patient = await run('wait'), impatient = await run('now'), quitter = await run('quit');
    expect(patient.later_share).toBe(1);
    expect(patient.estimated_k).toBeCloseTo(0.004);
    expect(patient.abandon_rate).toBe(0);
    expect(impatient.later_share).toBe(0);
    expect(impatient.estimated_k).toBe(1);
    expect(quitter.abandon_rate).toBe(1);
    expect(OFFERS.map((o) => Math.round(kOf(o) * 1000) / 1000)).toEqual([0.004, 0.01, 0.033, 0.1, 0.3, 1]);
  });

  it('9 renumbered floor: the sign-follower perseverates, the adaptive player adapts', async () => {
    const run = async (adapts: boolean) => {
      const d = await play('renumbered');
      for (let guard = 0; guard < 40; guard++) {
        const j = [...d.log()].reverse().find((e) => e.type === 'junction');
        if (!j || d.log().some((e) => e.type === 'outcome' && e.data.finished !== undefined)) break;
        const cues = j.data.cues as Record<string, string>;
        const switched = d.log().some((e) => e.type === 'rule_change');
        // The adaptive bot switches to the colleague after the sign has misled it once.
        const misled = d.log().some((e) => e.type === 'choice' && (e.data.followed as { signs: boolean }).signs && !e.data.correct);
        const dir = adapts && switched && misled ? cues.colleague! : cues.signs!;
        d.wait(2.6);
        d.press({ left: 't_left', ahead: 't_ahead', right: 't_right' }[dir]!);
      }
      d.wait(1);
      d.leave();
      return d.metrics();
    };
    const rigid = await run(false), adaptive = await run(true);
    expect(rigid.pre_switch_accuracy).toBe(1);
    expect(rigid.junctions_to_adapt).toBeNull();
    expect(rigid.perseverative_errors!).toBeGreaterThan(adaptive.perseverative_errors!);
    expect(adaptive.junctions_to_adapt).not.toBeNull();
  });

  it('10a pitch: an overconfident bot is caught by the Brier score', async () => {
    const run = async (p: number, land: boolean) => {
      const d = await play('pitch');
      d.goTo('t_lectern');
      d.press('t_lectern');
      for (let n = 0; n < 3; n++) {
        d.answer(p); // confidence
        d.answer(land ? 0.5 : 0.02); // where the marker stopped
        d.answer(n < 2 ? 0 : 1); // present again, then sit down
      }
      d.leave();
      return d.metrics();
    };
    const over = await run(100, false), calibrated = await run(0, false), good = await run(100, true);
    expect(over.pitches).toBe(3);
    expect(over.overconfidence).toBe(1);
    expect(over.brier).toBe(1);
    expect(calibrated.brier).toBe(0);
    expect(good.success_rate).toBe(1);
    expect(good.points).toBe(300);
  });

  it('10b loan: trust, its update, and trustworthiness', async () => {
    const run = async (lend: number, giveBack: number) => {
      const d = await play('loan');
      d.goTo('t_borrower');
      for (let r = 0; r < 2; r++) { d.press('t_borrower'); d.answer(lend); d.wait(1); }
      d.goTo('t_lender');
      d.press('t_lender');
      d.answer(giveBack);
      d.leave();
      return { m: d.metrics(), partner: d.room.task!.params.partner, log: d.log() };
    };
    const trusting = await run(10, 6), stingy = await run(0, 0);
    expect(trusting.m.initial_trust).toBe(1);
    expect(trusting.m.trust_update).toBe(0);
    expect(trusting.m.trustworthiness).toBe(0.5);
    expect(stingy.m.initial_trust).toBe(0);
    expect(stingy.m.trustworthiness).toBe(0);
    const send = trusting.log.find((e) => e.type === 'trust_send')!;
    expect(send.data.pot).toBe(30);
    expect(send.data.returned).toBe(trusting.partner === 'fair' ? 15 : 0);
  });

  it('11 lockdown: the escape artist, busy hands and the button pusher', async () => {
    const run = async (style: 'escape' | 'busy' | 'button') => {
      const d = await play('lockdown');
      const door = d.room.layout.doors.find((q) => !q.entrance)!.id;
      for (let s = 0; s < 95; s += 1) {
        if (style === 'escape') d.send({ type: 'door_tried', roomId: d.room.id, doorId: door, t: d.t });
        if (style === 'button' && s % 10 === 0) { d.goTo('t_buzzer', 0.8); d.press('t_buzzer'); }
        if (style === 'busy') {
          if (s === 0) d.goTo('t_pile', 0.8);
          if (s % 2 === 0) d.press('t_pile'); else d.press(`t_tray${1 + (s % 3)}`);
        }
        d.wait(1);
      }
      d.leave();
      return d.metrics();
    };
    const escape = await run('escape'), busy = await run('busy'), button = await run('button');
    expect(escape.escape_attempts!).toBeGreaterThan(50);
    expect(busy.files_sorted!).toBeGreaterThan(20);
    expect(busy.task_room_share!).toBeGreaterThan(0.5);
    expect(busy.time_to_explore).not.toBeNull();
    expect(button.buzzer_presses!).toBeGreaterThanOrEqual(9);
    expect(button.time_to_first_buzz!).toBeLessThan(30);
    expect(escape.notices_unlock).not.toBeNull();
  });

  it('every module replays from its log to the same metrics', async () => {
    for (const id of IDS) {
      const d = await play(id, 777);
      d.wait(3);
      for (const f of OFFICE_MODULES[id].needs.fixtures.slice(0, 2)) { d.goTo(f.id); d.press(f.id); if (d.ask()) d.answer(1); d.wait(1); }
      d.leave();
      const r = d.run.finalTaskResults().find((x) => x.task === id)!;
      const copy = JSON.parse(JSON.stringify(d.run.taskLog.events)) as TaskEvent[];
      const again = scoreAny(id, copy.filter((e) => e.task === id), { params: r.params, baseline: computeBaseline(copy.filter((e) => e.task === 'baseline')), all: copy });
      expect(again.metrics, id).toEqual(r.metrics);
      // Office versions tag their events, so office and mine can be scored apart later.
      expect(d.log().filter((e) => !['move', 'input', 'zone_enter', 'zone_exit', 'prompt_shown', 'narrator_start', 'narrator_end', 'task_start', 'task_end', 'interact', 'answer'].includes(e.type)).every((e) => e.data.version === 'office'), id).toBe(true);
    }
  });

  it('the default run is unchanged: tasks 1 to 5', async () => {
    const run = new Run(9, gameData, { observeMs: 0, tasks: true });
    let room = run.start();
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { room = await run.next(room.layout.doors.find((d) => !d.entrance)!.id); seen.push(room.task!.id); }
    expect(seen).toEqual(['two_doors', 'lift', 'desk', 'meeting', 'smoke']);
  });
});

describe('paired tasks: the balancing rule', () => {
  const risk = PAIRED.find((p) => p.id === 'balloons')!;
  it('a bot that skips the office gets the full mine allocation; one that does everything gets the minimum', () => {
    for (const t of PAIRED) {
      expect(baseMineTrials(t, 0), t.id).toBe(Math.min(t.max, t.target));
      expect(baseMineTrials(t, t.officeMax), t.id).toBe(Math.max(t.minMine, t.target - t.officeMax));
    }
    expect(baseMineTrials(risk, 10)).toBe(3);
    expect(baseMineTrials(risk, 0)).toBe(12);
  });
  it('tops up while the band is wide, up to the mine maximum', () => {
    expect(wantsAnother(risk, 3, 15)).toBe(true);
    expect(wantsAnother(risk, 3, 5)).toBe(false);
    expect(wantsAnother(risk, 12, 15)).toBe(false);
  });
  it('says whether a trait holds across office and mine', () => {
    expect(compareSettings({ mean: 50, se: 5, n: 5 }, { mean: 52, se: 5, n: 5 })!.verdict).toBe('consistent');
    expect(compareSettings({ mean: 80, se: 5, n: 5 }, { mean: 40, se: 5, n: 5 })!.verdict).toBe('context-dependent');
    expect(compareSettings({ mean: 80, se: 5, n: 2 }, { mean: 40, se: 5, n: 5 })).toBeNull();
  });
});
