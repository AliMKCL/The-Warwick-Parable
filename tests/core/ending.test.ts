import { describe, expect, it } from 'vitest';
import { gameData } from '../../core/data';
import type { CoreMessage, Dossier } from '../../core/protocol';
import { createCore } from '../../core/run/core';
import { fakeLlm } from './fakeLlm';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function playToEnd(llm: ReturnType<typeof fakeLlm> | undefined, runLength: number) {
  const core = createCore(gameData, { llm, observeMs: 0, runLength });
  const msgs: CoreMessage[] = [];
  core.onMessage((m) => msgs.push(m));
  core.send({ type: 'run_started', seed: 31, t: 0 });
  let t = 0;
  for (let i = 0; i < runLength; i++) {
    const room = core.run()!.current!;
    core.send({ type: 'room_entered', roomId: room.id, t: (t += 1) });
    if (i === 0) {
      const button = room.props.find((p) => p.recipe === 'button_pedestal')!;
      core.send({ type: 'pressed', roomId: room.id, objectId: button.id, t: (t += 25) });
    }
    const p = room.props.find((x) => gameData.props.find((r) => r.id === x.recipe)?.inspectable);
    if (p) core.send({ type: 'inspected', roomId: room.id, objectId: p.id, t: (t += 4) });
    await tick(20);
    const exit = room.layout.doors.find((d) => !d.entrance)!;
    core.send({ type: 'door_chosen', roomId: room.id, doorId: exit.id, t: (t += 10) });
    await tick(30);
  }
  await tick(50);
  return { core, msgs, dossier: (msgs.find((m) => m.type === 'run_ended') as Extract<CoreMessage, { type: 'run_ended' }> | undefined)?.dossier };
}

function checkDossier(d: Dossier | undefined, rooms: number) {
  expect(d).toBeDefined();
  expect(d!.rooms).toHaveLength(rooms);
  expect(d!.rooms[0]!.title).toBe('The waiting room');
  expect(d!.moments.hesitation.some((e) => /button/.test(e.reason))).toBe(true);
  expect(d!.stats.inspected).toBeGreaterThan(0);
  expect(d!.verdict.name.length).toBeGreaterThan(3);
  expect(d!.rooms.every((r) => typeof r.traitsAtEntry.hesitation === 'number')).toBe(true);
}

describe('the ending', () => {
  it('ends after the final room with a model-written verdict and the full record', async () => {
    const { dossier, msgs } = await playToEnd(fakeLlm(), 5);
    checkDossier(dossier, 5);
    expect(dossier!.verdictSource).toBe('model');
    expect(dossier!.verdict.name).toBe('The Patient Applicant');
    // Later rooms record what the model was told.
    expect(dossier!.rooms[2]!.behaviour.join(' ')).toMatch(/Pressed the button/);
    expect(msgs.filter((m) => m.type === 'load_room')).toHaveLength(5);
  });

  it('still ends with a template verdict when there is no model', async () => {
    const { dossier } = await playToEnd(undefined, 4);
    checkDossier(dossier, 4);
    expect(dossier!.verdictSource).toBe('template');
    expect(dossier!.verdict.name).toMatch(/^The /);
  });
});
