/**
 * npm run try:room
 *
 * Plays the first room with a scripted player (hesitates, presses the
 * button, reads the notice board, lingers at a door), then asks the real
 * model for the next room exactly as the game does. Prints the timings, the
 * room it wrote, the live narrator reaction and a map.
 */
import { createLlmClient } from '../core/llm/client';
import { footprintCells } from '../core/room/geometry';
import type { CoreMessage } from '../core/protocol';
import type { RoomSpec } from '../core/room/types';
import { createCore } from '../core/run/core';
import { loadGameData } from './data-node';
import { llmConfigFromEnv, loadProjectEnv, parallelFromEnv } from './env';

loadProjectEnv();
const data = loadGameData();
const llm = createLlmClient(llmConfigFromEnv(), { fetch: (u, i) => fetch(u, i as RequestInit), now: () => performance.now() });
const seed = Number(process.argv[2]) || Math.floor(Math.random() * 1e6);
const core = createCore(data, { llm, observeMs: 0, waitMs: 60_000, concurrency: parallelFromEnv() });
const msgs: CoreMessage[] = [];
core.onMessage((m) => msgs.push(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ping = await llm.ping();
  if (!ping.ok || !ping.hasModel) {
    console.error('Model not ready. Run `npm run check:llm` first.');
    process.exit(1);
  }
  console.log(`Seed ${seed}. Playing the first room with a hesitant player...\n`);
  const t0 = performance.now();
  core.send({ type: 'run_started', seed, t: 0 });
  const first = core.run()!.current!;
  const id = first.id;
  const prop = (r: string) => first.props.find((p) => p.recipe === r)?.id ?? first.props[0]!.id;
  core.send({ type: 'room_entered', roomId: id, t: 0 });
  core.send({ type: 'looked_at', roomId: id, objectId: prop('button_pedestal'), seconds: 9, t: 14 });
  core.send({ type: 'idle', roomId: id, seconds: 11, t: 16 });
  core.send({ type: 'pressed', roomId: id, objectId: prop('button_pedestal'), t: 31 });
  core.send({ type: 'inspected', roomId: id, objectId: prop('memo_board'), t: 40 });
  const exits = first.layout.doors.filter((d) => !d.entrance);
  core.send({ type: 'door_hovered', roomId: id, doorId: exits.at(-1)!.id, seconds: 2.4, t: 48 });

  // Wait for the room behind the first door, like a player walking up to it.
  const target = exits[0]!.id;
  for (let i = 0; i < 600; i++) {
    const s = core.run()!.plansStatus().find((p) => p.door === target)!;
    if (s.status === 'ready' || s.status === 'fallback') break;
    await sleep(100);
  }
  const genSeconds = (performance.now() - t0) / 1000;
  core.send({ type: 'door_chosen', roomId: id, doorId: target, t: 60 });
  for (let i = 0; i < 200 && msgs.filter((m) => m.type === 'load_room').length < 2; i++) await sleep(50);
  await sleep(200);
  const room = (msgs.filter((m) => m.type === 'load_room').at(-1) as Extract<CoreMessage, { type: 'load_room' }>).spec;
  for (let i = 0; i < 160; i++) {
    const last = msgs.filter((m) => m.type === 'narrator_line').at(-1) as any;
    if (last?.final && last.text === room.narrator.onEnter) break;
    await sleep(50);
  }

  const status = core.run()!.plansStatus();
  const all = core.run()!.plansStatus();
  console.log(`Generating ${parallelFromEnv()} room(s) at a time. Behind this room's ${exits.length} doors: ${all.map((p) => `${p.door} ${p.status}${p.ms ? ` ${(p.ms / 1000).toFixed(1)} s` : ''}`).join(', ')}`);
  console.log(`Room behind "${exits[0]!.label}": ${room.source === 'model' ? '✓ written by the model' : '✗ fell back to templates'} in ${genSeconds.toFixed(1)} s`);
  const err = core.run()!.rooms.length && status.find((p) => p.error)?.error;
  if (err) console.log(`  model problem: ${err}`);
  printRoom(room);
  console.log('\nPlayer profile after the first room (strongest first):');
  for (const l of core.run()!.profile.readout()) console.log(`  ${l}`);
  for (const e of core.run()!.profile.evidence) console.log(`    ${e.delta > 0 ? '+' : ''}${e.delta} ${e.trait}: ${e.reason}`);
  const reaction = msgs.filter((m): m is Extract<CoreMessage, { type: 'narrator_line' }> => m.type === 'narrator_line' && m.final);
  console.log('\nNarrator, in order:');
  for (const l of reaction) console.log(`  “${l.text}”`);
  process.exit(0);
}

function printRoom(r: RoomSpec) {
  const L = r.layout;
  console.log(`\n"${r.title}" · ${L.archetype} ${L.width}x${L.depth} · ${r.ambience}`);
  if (r.fact) console.log(`Fact: ${r.fact}`);
  if (r.rule) console.log(`Rule: ${r.rule.id} ${JSON.stringify(r.rule.params)}\n  says: “${r.rule.line}”${r.rule.doneLine ? `\n  then: “${r.rule.doneLine}”` : ''}`);
  if (r.thread?.plant) console.log(`New story thread: ${r.thread.plant}`);
  console.log('\nDoors:');
  for (const d of L.doors) console.log(`  ${d.entrance ? 'in ' : d.id + ' '} "${d.label}"${d.entrance ? '' : ` → if you hesitate: “${r.narrator.doors[d.id] ?? ''}”`}`);
  console.log('\nThings with text:');
  for (const p of r.props.filter((x) => x.surfaceText || x.inspectText)) {
    console.log(`  ${p.recipe.padEnd(16)} ${p.surfaceText ? JSON.stringify(p.surfaceText) : ''}${p.inspectText ? `  (inspect: ${p.inspectText})` : ''}`);
  }
  const g = L.cells.map((row) => row.split(''));
  for (const p of r.props) {
    const rec = data.props.find((x) => x.id === p.recipe)!;
    if (rec.fits.every((f) => f === 'wall_mounted')) continue;
    for (const [cx, cz] of footprintCells(p.x, p.z, p.rotY, rec.size[0], rec.size[2])) if (g[cz]?.[cx]) g[cz]![cx] = rec.id[0]!.toUpperCase();
  }
  for (const d of L.doors) g[d.cz]![d.cx] = d.entrance ? '@' : d.id.slice(1);
  console.log('\nMap (@ = entrance, digits = exits, letters = props):');
  console.log(g.map((x) => '  ' + x.join(' ')).join('\n'));
}

main();
