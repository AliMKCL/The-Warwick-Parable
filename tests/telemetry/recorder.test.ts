import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { CoreMessage } from '../../core/protocol';
import type { RoomSpec } from '../../core/room/types';
import { createCore } from '../../core/run/core';
import { Recorder } from '../../web/telemetry/recorder';
import type { TelemetryEvent } from '../../web/telemetry/telemetry';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup() {
  let clock = 0;
  const rows: TelemetryEvent[] = [];
  const ended: { profile: unknown; predictions: unknown }[] = [];
  const recorder = new Recorder({
    log: (e) => rows.push(e),
    end: (profile, predictions) => ended.push({ profile, predictions }),
    now: () => clock,
    inspectable: (id) => {
      const r = gameData.props.find((p) => p.id === id);
      return !!r?.inspectable && r.interact !== 'button';
    },
  });
  return { recorder, rows, ended, advance: (ms: number) => (clock += ms) };
}

/** A real generated room with the given rule. */
function roomWith(rule: RoomSpec['rule']): RoomSpec {
  const core = createCore(gameData);
  let spec!: RoomSpec;
  core.onMessage((m) => m.type === 'load_room' && (spec = m.spec));
  core.send({ type: 'run_started', seed: 5, t: 0 });
  return { ...spec, id: 'room-x', index: 2, props: spec.props.filter((p) => p.recipe !== 'button_pedestal'), rule };
}

describe('telemetry recorder', () => {
  it('records a whole run: rooms, the button task, tagged choices, and the ending', async () => {
    const { recorder, rows, ended, advance } = setup();
    const core = createCore(gameData, { observeMs: 0, runLength: 3 });
    core.onMessage((m) => recorder.message(m));
    const send = (e: Parameters<typeof core.send>[0]) => { recorder.event(e); core.send(e); };
    send({ type: 'run_started', seed: 9, t: 0 });
    for (let i = 0; i < 3; i++) {
      const room = core.run()!.current!;
      send({ type: 'room_entered', roomId: room.id, t: i * 10 });
      if (i === 0) {
        advance(4000);
        const button = room.props.find((p) => p.recipe === 'button_pedestal')!;
        send({ type: 'pressed', roomId: room.id, objectId: button.id, t: 4 });
      }
      advance(2000);
      const exit = room.layout.doors.find((d) => !d.entrance)!;
      recorder.act({ kind: 'locked', id: room.layout.doors.find((d) => d.entrance)?.id ?? 'x' });
      recorder.act({ kind: 'door', id: exit.id, locked: false });
      send({ type: 'door_chosen', roomId: room.id, doorId: exit.id, t: i * 10 + 8 });
      await tick(30);
    }
    await tick(50);

    const types = rows.map((r) => r.type);
    expect(types.filter((t) => t === 'room_enter')).toHaveLength(3);
    expect(types.filter((t) => t === 'room_exit')).toHaveLength(3);
    expect(types).toContain('backtrack_attempt');
    expect(types.at(-1)).toBe('run_end');

    const press = rows.find((r) => r.type === 'choice' && r.choice === 'press_button')!;
    expect(press).toMatchObject({ trait: 'social', trait_value: 'follow', latency_ms: 4000 });
    expect(rows.find((r) => r.type === 'task_done' && r.choice === 'press_button')?.meta?.duration_ms).toBe(4000);
    expect(rows.find((r) => r.type === 'interact')?.meta).toMatchObject({ action: 'press', recipe: 'button_pedestal' });

    const doors = rows.filter((r) => r.type === 'choice' && r.meta?.kind === 'door');
    expect(doors).toHaveLength(3);
    expect(doors[0]!.latency_ms).toBe(6000);
    for (const d of doors) expect(d.meta).toHaveProperty('pressure');

    expect(ended).toHaveLength(1);
    expect(ended[0]!.predictions).toHaveProperty('labels');
    expect(ended[0]!.profile).toHaveProperty('evidence');
  });

  it('tags a skipped button and an unexplored room', () => {
    const { recorder, rows, advance } = setup();
    const core = createCore(gameData);
    core.onMessage((m) => recorder.message(m));
    core.send({ type: 'run_started', seed: 3, t: 0 });
    const room = core.run()!.current!;
    recorder.event({ type: 'room_entered', roomId: room.id, t: 0 });
    advance(1500);
    recorder.act({ kind: 'door', id: room.layout.doors.find((d) => !d.entrance)!.id, locked: false });
    expect(rows.find((r) => r.choice === 'ignore_button')).toMatchObject({ trait: 'social', trait_value: 'independent' });
    expect(rows.find((r) => r.type === 'task_skipped')?.meta?.reason).toBe('left_without_pressing');
    expect(rows.find((r) => r.type === 'choice' && r.meta?.kind === 'door')).toMatchObject({ trait: 'exploration', trait_value: 'skip' });
  });

  it('marks timer pressure, then waiting it out', () => {
    const { recorder, rows, advance } = setup();
    const spec = roomWith({ id: 'exit_timer', params: { seconds: 30 }, line: 'Go.', doneLine: 'Done.' });
    const exit = spec.layout.doors.find((d) => !d.entrance)!;
    recorder.message({ type: 'load_room', spec });
    recorder.event({ type: 'room_entered', roomId: spec.id, t: 0 });
    recorder.message({ type: 'rule_effect', effect: { kind: 'timer', seconds: 30, label: '' } });
    advance(5000);
    recorder.event({ type: 'door_hovered', roomId: spec.id, doorId: exit.id, seconds: 1.5, t: 5 });
    expect(rows.at(-1)!.meta).toMatchObject({ pressure: true, pressure_source: ['timer'] });
    advance(30000);
    recorder.message({ type: 'rule_effect', effect: { kind: 'timer', seconds: null, label: '' } });
    expect(rows.find((r) => r.type === 'task_skipped')?.meta?.reason).toBe('expired');
    recorder.act({ kind: 'door', id: exit.id, locked: false });
    const choice = rows.find((r) => r.type === 'choice')!;
    expect(choice).toMatchObject({ trait: 'patience', trait_value: 'wait' });
    expect(choice.meta?.pressure).toBe(false);
  });

  it('tags following the narrator and measures latency from when inspect-to-unlock doors open', () => {
    const { recorder, rows, advance } = setup();
    const base = roomWith(undefined);
    const exits = base.layout.doors.filter((d) => !d.entrance);
    const suggest = { ...base, rule: { id: 'narrator_suggests' as const, params: { door: exits[0]!.id, lie: 1 }, line: 'Take that one.', doneLine: '' } };
    recorder.message({ type: 'load_room', spec: suggest });
    recorder.event({ type: 'room_entered', roomId: suggest.id, t: 0 });
    recorder.message({ type: 'narrator_line', lineId: 'l1', text: 'Take that one.', final: true } satisfies CoreMessage);
    advance(3000);
    recorder.act({ kind: 'door', id: exits[0]!.id, locked: false });
    expect(rows.find((r) => r.type === 'choice')).toMatchObject({ trait: 'social', trait_value: 'follow', meta: { pressure: true, pressure_source: ['narrator'], narrator_lie: true } });

    rows.length = 0;
    const lock = { ...base, id: 'room-y', rule: { id: 'inspect_to_unlock' as const, params: { count: 2 }, line: '', doneLine: '' } };
    recorder.message({ type: 'load_room', spec: lock });
    recorder.event({ type: 'room_entered', roomId: lock.id, t: 10 });
    recorder.message({ type: 'rule_effect', effect: { kind: 'doors', locked: exits.map((d) => d.id) } });
    advance(8000);
    recorder.message({ type: 'rule_effect', effect: { kind: 'doors', locked: [] } });
    advance(1000);
    recorder.act({ kind: 'door', id: exits[0]!.id, locked: false });
    expect(rows.find((r) => r.type === 'task_done')?.meta?.duration_ms).toBe(8000);
    expect(rows.find((r) => r.type === 'choice')).toMatchObject({ trait: null, latency_ms: 1000 });
  });

  it('tags gamble doors as risk, with the clock as pressure and the real outcome in meta', () => {
    const { recorder, rows, advance } = setup();
    const room = roomWith({ id: 'gamble', params: { safe: 'd1', risky: 'd2', seconds: 15, outcome: 'setback', stakes: 's' }, line: 'x', doneLine: 'y' });
    room.layout = { ...room.layout, doors: [...room.layout.doors.filter((d) => d.entrance), { ...room.layout.doors.find((d) => !d.entrance)!, id: 'd1' }, { ...room.layout.doors.find((d) => !d.entrance)!, id: 'd2' }] };
    recorder.message({ type: 'load_room', spec: room });
    recorder.event({ type: 'room_entered', roomId: room.id, t: 0 });
    recorder.message({ type: 'rule_effect', effect: { kind: 'timer', seconds: 15, label: '50/50 closes in' } });
    advance(3000);
    recorder.act({ kind: 'door', id: 'd2', locked: false });
    const choice = rows.find((r) => r.type === 'choice')!;
    expect(choice).toMatchObject({ trait: 'risk', trait_value: 'risky' });
    expect(choice.meta).toMatchObject({ pressure: true, gamble: { timed: true, expired: false, outcome: 'setback' } });
    expect(rows.some((r) => r.type === 'gamble_offer')).toBe(true);
    expect(rows.some((r) => r.type === 'task_start' && r.choice === 'beat_timer')).toBe(false);
  });

  it('saves the said/did comparison in the session profile', async () => {
    const { recorder, ended } = setup();
    const core = createCore(gameData, { observeMs: 0, runLength: 3 });
    core.onMessage((m) => recorder.message(m));
    const send = (e: Parameters<typeof core.send>[0]) => { recorder.event(e); core.send(e); };
    send({ type: 'run_started', seed: 9, t: 0, selfRatings: { risk: 2, patience: 4, social: 5, exploration: 1 } });
    for (let i = 0; i < 3; i++) {
      const room = core.run()!.current!;
      send({ type: 'room_entered', roomId: room.id, t: i * 10 });
      send({ type: 'door_chosen', roomId: room.id, doorId: room.layout.doors.find((d) => !d.entrance)!.id, t: i * 10 + 8 });
      await tick(30);
    }
    await tick(50);
    const profile = ended[0]!.profile as any;
    expect(profile.said_did.rows).toHaveLength(4);
    expect(profile.said_did.rows.find((r: any) => r.trait === 'social')).toMatchObject({ said: 5, did: 1 });
    expect(profile.said_did.headline).toMatch(/^You said you do what you're told\. You never pressed the button/);
    expect(profile.measured.risk.estimated).toBe(true);
    expect((ended[0]!.predictions as any).said_did_headline).toBe(profile.said_did.headline);
  });
});
