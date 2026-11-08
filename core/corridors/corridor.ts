import type { GameEvent } from '../protocol';
import { DIR, OPPOSITE, ROTATE_CW, yawForFacing } from '../room/geometry';
import { rotateCW } from '../room/layouts';
import type { Door, GameData, Layout, RoomSpec, Side } from '../room/types';
import { createRng, deriveSeed, pick, randInt } from '../util/random';

/** Observe briefly before speculating on the next rooms. Door focus can start sooner. */
export const ROOM_OBSERVE_MS = 3000;
/** Maximum generation time after committing to a corridor, including walking/exploration. */
export const CORRIDOR_PREPARE_MS = 45000;
/** Maximum additional wait after first requesting the exit. Repeated presses never reset it. */
export const CORRIDOR_EXIT_WAIT_MS = 10000;

export interface CorridorStory {
  entry: string;
  receipt: string;
  archive: string;
  replies: Record<string, string>;
}

/** Authored, instant callbacks: only refer to actions present in this room's event log. */
export function corridorStory(room: RoomSpec, door: Door, events: GameEvent[], data: GameData): CorridorStory {
  const mine = events.filter((e) => 'roomId' in e && e.roomId === room.id);
  const read = mine.filter((e) => e.type === 'inspected');
  const presses = mine.filter((e) => e.type === 'pressed');
  const hovered = mine.some((e) => e.type === 'door_hovered' && e.doorId === door.id);
  const anomaly = mine.find((e) => e.type === 'anomaly_action');
  const label = door.label ? `“${door.label}”` : 'the unmarked door';
  const rng = createRng(deriveSeed(room.seed, `passage-story-${door.id}`));
  let action: string;
  if (anomaly?.type === 'anomaly_action') {
    action = anomaly.action === 'erase'
      ? 'You retraced your footprints. The record of trying to erase them is, of course, permanent.'
      : anomaly.action === 'stay'
        ? 'You asked to stay, and then left. The building has filed both requests together.'
        : 'You investigated the irregularity back there. It now has a witness, which is almost as useful as an explanation.';
  } else if (read.length) {
    const last = read[read.length - 1]!;
    const prop = room.props.find((p) => p.id === last.objectId);
    const name = data.props.find((p) => p.id === prop?.recipe)?.name.toLowerCase() ?? 'document';
    action = `You stopped to examine the ${name}. The building files attention just as carefully as obedience.`;
  } else if (presses.length) {
    action = presses.length > 1
      ? `You pressed ${presses.length} times back there. The building has recorded each press as a separate expression of confidence.`
      : 'You pressed the button back there. Somewhere, an empty office has received your enthusiasm.';
  } else if (hovered) {
    action = 'You considered this door before taking it. The pause has been filed alongside the decision.';
  } else {
    action = pick(rng, [
      'Nothing inspected back there. The building has left a space for your reasons.',
      'You left the objects to explain themselves. They have submitted rather different accounts.',
      'You inspected nothing. A blank entry is still an entry in your file.',
    ]);
  }
  let choice = `You chose ${label}.`;
  const rule = room.rule;
  if (rule?.id === 'gamble') choice = door.id === rule.params.risky
    ? 'You took the uncertain route. The building keeps the choice and the outcome in separate drawers.'
    : 'You took the certain route. Certainty has its own department.';
  else if (rule?.id === 'narrator_suggests') choice = door.id === rule.params.door
    ? `You followed the recommendation for ${label}. It has been stamped as your decision.`
    : `You chose ${label}, away from the recommendation. The building keeps a drawer for amendments.`;
  const fact = room.fact || room.thread?.plant;
  return {
    entry: `${choice} ${action}`,
    receipt: `ROUTE RECEIPT\nFrom: ${room.title}\nSelected: ${door.label || 'UNMARKED'}\nObjects inspected: ${read.length}\nButtons pressed: ${presses.length}\n\n${action}\n\nPrevious departments cannot be re-entered. Your original decision remains on file.`,
    archive: fact
      ? `TRANSFER TO RECORDS\n\nThe previous department reported:\n“${fact}”\n\nThis statement travels with your file. The next department may interpret it differently.`
      : 'TRANSFER TO RECORDS\n\nThe rooms collect decisions. These passages carry them to Records. No member of staff has signed for a delivery in years. Your file continues to grow.',
    replies: {
      receipt: 'A receipt for your own decision. Do keep it; the building already has the original.',
      archive: fact ? 'That is the account the previous room sent ahead. An observation becomes official remarkably quickly.' : 'No signature, but the records still arrive. Someone has been maintaining the procedure after the purpose left.',
      acknowledge: 'Acknowledged. That confirms you saw the record; it does not require you to agree with it.',
    },
  };
}

export const CORRIDOR_EVENTS = ['breaking_window', 'falling_art', 'paper_gust'] as const;
export type CorridorEventKind = typeof CORRIDOR_EVENTS[number];
export interface CorridorDetails {
  windows: { cx: number; cz: number; side: Side }[];
  event?: { kind: CorridorEventKind; cx: number; cz: number; side: Side };
}

/** Straight, seeded passage. A narrow neck at either end joins just the doorway. */
export function createCorridor(room: RoomSpec, door: Door, story: CorridorStory, data: GameData): RoomSpec {
  const seed = deriveSeed(room.seed, `passage-${door.id}`);
  const rng = createRng(seed), depth = randInt(rng, 18, 24);
  const cells = Array.from({ length: depth }, (_, z) => z < 2 || z >= depth - 2 ? '##.##' : '.....');
  const eventKind = rng() < 0.55 ? pick(rng, CORRIDOR_EVENTS) : undefined;
  const eventZ = Math.floor(depth / 2), eventSide: Side = rng() < 0.5 ? 'w' : 'e';
  const corridor: CorridorDetails = { windows: [] };
  if (eventKind) corridor.event = { kind: eventKind, cx: eventSide === 'w' ? 0 : 4, cz: eventZ, side: eventSide };
  for (let z = 4; z < depth - 3; z += 4) {
    for (const side of ['w', 'e'] as const) {
      if (eventKind && Math.abs(z - eventZ) < 2) continue;
      corridor.windows.push({ cx: side === 'w' ? 0 : 4, cz: z, side });
    }
  }
  if (eventKind === 'breaking_window') corridor.windows.push({ cx: eventSide === 'w' ? 0 : 4, cz: eventZ, side: eventSide });
  let layout: Layout = {
    archetype: 'transfer_corridor', width: 5, depth, ceiling: 2.8, cells, slots: [],
    doors: [
      { id: 'in', cx: 2, cz: depth - 1, side: 's', entrance: true, label: '' },
      { id: 'onward', cx: 2, cz: 0, side: 'n', entrance: false, label: 'NEXT DEPARTMENT', fixedLabel: true },
    ],
    spawn: { x: 2.5, z: depth - 0.8, yaw: 0 },
    fixtures: [{ id: 'interlock', recipe: 'sign_wall', x: 0.03, y: 1.6, z: 2.5, face: 'e', surfaceText: 'TRANSFER INTERLOCK\nRELEASES WHEN READY', inspectText: 'The next department opens when the transfer is complete. You may explore this corridor in the meantime.' }],
  };
  // Ordinary interactables only: test equipment and people belong in their rooms.
  // Draw without replacement, keeping the existing clearance beside the route.
  const pool = data.props.filter((p) => (p.inspectable || p.interact)
    && !p.tags.includes('task') && !p.tags.includes('person')
    && p.size[0] <= 2 && p.size[2] <= 1.2 && p.size[1] <= 2.6);
  const count = Math.min(randInt(rng, 3, 5), pool.length);
  const anchors: { z: number; side: 'w' | 'e' }[] = [];
  for (let z = 2; z < depth - 3; z += 2) for (const side of ['w', 'e'] as const) {
    if (z < 4 && side === 'w') continue;
    if (eventKind && Math.abs(z + 0.5 - (eventZ + 0.5)) < 2) continue;
    if (corridor.windows.some((w) => w.side === side && Math.abs(z + 0.5 - (w.cz + 0.5)) < 1.5)) continue;
    anchors.push({ z: z + 0.5, side });
  }
  for (let i = 0; i < count && anchors.length; i++) {
    const recipe = pool.splice(randInt(rng, 0, pool.length - 1), 1)[0]!;
    const a = anchors.splice(randInt(rng, 0, anchors.length - 1), 1)[0]!;
    const mounted = recipe.fits.every((f) => f === 'wall_mounted') || ['lift_call', 'intercom', 'buzzer_button'].includes(recipe.id);
    const offset = recipe.size[2] / 2 + 0.04;
    const id = recipe.id === 'memo_board' ? (rng() < 0.5 ? 'receipt' : 'archive') : recipe.id === 'button_pedestal' ? 'acknowledge' : `corridor-prop-${i}`;
    layout.fixtures!.push({ id, recipe: recipe.id, x: a.side === 'w' ? offset : 5 - offset, y: mounted ? recipe.mountHeight ?? 1.35 : 0, z: a.z, face: a.side === 'w' ? 'e' : 'w',
      surfaceText: id === 'receipt' ? 'ROUTE RECEIPT' : id === 'archive' ? 'RECORDS TRANSFER' : id === 'acknowledge' ? 'ACKNOWLEDGE' : 'TRANSFER DEPARTMENT',
      inspectText: id === 'receipt' ? story.receipt : id === 'archive' ? story.archive : `${recipe.name}. Assigned to the transfer department. The inventory lists it as “temporarily here”.`,
    });
  }
  while (layout.doors[0]!.side !== OPPOSITE[door.side]) {
    const rotate = (p: { cx: number; cz: number; side: Side }) => ({ cx: layout.depth - 1 - p.cz, cz: p.cx, side: ROTATE_CW[p.side] });
    corridor.windows = corridor.windows.map(rotate);
    if (corridor.event) corridor.event = { ...corridor.event, ...rotate(corridor.event) };
    layout = rotateCW(layout);
  }
  return {
    id: `passage-${room.id}-${door.id}`, index: room.index, seed, layout, corridor,
    title: 'Records transfer', ambience: seed % 2 ? 'warm' : 'cold', source: 'template',
    narrator: { onEnter: story.entry, doors: {} },
    props: layout.fixtures!.map((f) => ({ ...f, slot: 'fixture', rotY: yawForFacing(f.face), featured: false })),
  };
}

export function doorPoint(door: Door) {
  const [dx, dz] = DIR[door.side];
  return { x: door.cx + 0.5 + dx * 0.5, z: door.cz + 0.5 + dz * 0.5 };
}
