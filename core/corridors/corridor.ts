import type { GameEvent } from '../protocol';
import { DIR, OPPOSITE, yawForFacing } from '../room/geometry';
import { rotateCW } from '../room/layouts';
import type { Door, GameData, Layout, RoomSpec } from '../room/types';
import { createRng, deriveSeed, pick } from '../util/random';

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

/** A dogleg with two bends. Narrow necks join precisely one doorway cell at each end. */
export function createCorridor(room: RoomSpec, door: Door, story: CorridorStory): RoomSpec {
  const seed = deriveSeed(room.seed, `passage-${door.id}`);
  const depth = 18 + (seed % 3) * 2;
  const cells = Array.from({ length: depth }, (_, z) => Array.from({ length: 9 }, (_, x) => {
    const floor = z < 2 ? x === 7 : z < 8 ? x >= 6 : z <= 10 ? true : z < depth - 2 ? x <= 2 : x === 1;
    return floor ? '.' : '#';
  }).join(''));
  let layout: Layout = {
    archetype: 'transfer_corridor', width: 9, depth, ceiling: 2.8, cells, slots: [],
    doors: [
      { id: 'in', cx: 1, cz: depth - 1, side: 's', entrance: true, label: '' },
      { id: 'onward', cx: 7, cz: 0, side: 'n', entrance: false, label: 'NEXT DEPARTMENT', fixedLabel: true },
    ],
    spawn: { x: 1.5, z: depth - 0.8, yaw: 0 },
    fixtures: [
      { id: 'receipt', recipe: 'memo_board', x: 0.03, y: 1.5, z: depth - 4, face: 'e', surfaceText: 'ROUTE RECEIPT\nYOUR DECISION IS ON FILE', inspectText: story.receipt },
      { id: 'archive', recipe: 'memo_board', x: 4.5, y: 1.5, z: 10.97, face: 'n', surfaceText: 'RECORDS\nNO SIGNATURE REQUIRED', inspectText: story.archive },
      { id: 'acknowledge', recipe: 'button_pedestal', x: 8.45, y: 0, z: 4.8, face: 'w', surfaceText: 'ACKNOWLEDGE', inspectText: 'Acknowledge your record' },
      { id: 'interlock', recipe: 'sign_wall', x: 6.03, y: 1.6, z: 2.8, face: 'e', surfaceText: 'TRANSFER INTERLOCK\nRELEASES WHEN READY', inspectText: 'The next department opens when the transfer is complete. You may explore this corridor in the meantime.' },
      { id: 'direction', recipe: 'sign_wall', x: 6.03, y: 1.8, z: 5.8, face: 'e', surfaceText: 'ACKNOWLEDGEMENT\nOPTIONAL' },
      { id: 'cabinet', recipe: 'filing_cabinet', x: 0.45, y: 0, z: 11.8, face: 'e', inspectText: 'These files have no names. Each is indexed by a door someone chose.' },
    ],
  };
  while (layout.doors[0]!.side !== OPPOSITE[door.side]) layout = rotateCW(layout);
  return {
    id: `passage-${room.id}-${door.id}`, index: room.index, seed, layout,
    title: 'Records transfer', ambience: seed % 2 ? 'warm' : 'cold', source: 'template',
    narrator: { onEnter: story.entry, doors: {} },
    props: layout.fixtures!.map((f) => ({ ...f, slot: 'fixture', rotY: yawForFacing(f.face), featured: false })),
  };
}

export function doorPoint(door: Door) {
  const [dx, dz] = DIR[door.side];
  return { x: door.cx + 0.5 + dx * 0.5, z: door.cz + 0.5 + dz * 0.5 };
}
