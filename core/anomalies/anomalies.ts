import type { GameEvent, AnomalyEffect } from '../protocol';
import type { GameData, PlacedProp, RoomSpec } from '../room/types';
import { placeAssignments } from '../room/place';
import { createRng, deriveSeed, pick } from '../util/random';
import { ANOMALY_ROOM_CHANCE, MAX_ANOMALIES_PER_RUN } from './config';
import {
  ANOMALIES,
  ANOMALY_ANCHOR,
  definition,
  type AnomalyId,
} from './catalog';

export interface AnomalySpec {
  id: AnomalyId;
  anchor: PlacedProp;
  doorId: string;
  record: string;
}

/** Attach only when the room is entered. Unvisited speculative branches never spend the budget. */
export function attachAnomaly(
  room: RoomSpec,
  rooms: RoomSpec[],
  events: GameEvent[],
  data: GameData,
  last: number,
  runSeed: number,
  cap = MAX_ANOMALIES_PER_RUN,
): void {
  const used = rooms.flatMap((r) => (r.anomaly ? [r.anomaly.id] : []));
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  if (
    room.index === 0 ||
    room.index >= last ||
    used.length >= limit ||
    rooms.at(-1)?.anomaly
  )
    return;
  const rng = createRng(
    deriveSeed(runSeed, `anomaly-${room.index}-${room.seed}`),
  );
  if (rng() >= ANOMALY_ROOM_CHANCE) return;
  const declined = rooms.flatMap((r) => {
    const chosen = events.find(
      (e) => e.type === 'door_chosen' && e.roomId === r.id,
    );
    return chosen?.type === 'door_chosen'
      ? r.layout.doors
          .filter((d) => !d.entrance && d.id !== chosen.doorId)
          .map((d) => `Room ${r.index}: ${d.label}`)
      : [];
  });
  const eligible = ANOMALIES.filter(
    (a) =>
      !used.includes(a.id) &&
      // In an office task room the doors are part of the test: nothing relabels or hides them.
      (!room.task || (a.id !== 'blue_door' && a.id !== 'false_exit')) &&
      (a.id !== 'borrowed_clock' || room.rule?.id === 'exit_timer') &&
      (a.id !== 'copier_route' || declined.length > 0) &&
      (a.id !== 'false_exit' ||
        (!room.rule &&
          room.layout.doors.filter((d) => !d.entrance).length > 1)),
  );
  if (!eligible.length) return;
  const slots = room.layout.slots.filter((s) => s.kind === 'wall');
  if (!slots.length) return;
  const slot = pick(rng, slots);
  const placed = placeAssignments(
    room.layout,
    [
      { slot: slot.id, recipe: ANOMALY_ANCHOR.id },
      ...room.props.filter((p) => p.slot !== slot.id).map((p) => ({ ...p })),
    ],
    { ...data, props: [...data.props, ANOMALY_ANCHOR] },
  ).props;
  const anchor = placed.find((p) => p.recipe === ANOMALY_ANCHOR.id);
  if (!anchor) return;
  const selected = pick(rng, eligible);
  const previous = [...events]
    .reverse()
    .find(
      (e) =>
        e.type === 'inspected' ||
        e.type === 'pressed' ||
        e.type === 'door_chosen',
    );
  let record = 'No earlier interaction was recorded.';
  if (previous) {
    const oldRoom = rooms.find(
      (r) => 'roomId' in previous && r.id === previous.roomId,
    );
    if (previous.type === 'door_chosen')
      record = `You chose ${oldRoom?.layout.doors.find((d) => d.id === previous.doorId)?.label ?? previous.doorId} in room ${oldRoom?.index ?? 0}.`;
    else if (previous.type === 'inspected' || previous.type === 'pressed') {
      const prop = oldRoom?.props.find((p) => p.id === previous.objectId);
      record = `You ${previous.type} ${data.props.find((r) => r.id === prop?.recipe)?.name ?? 'an object'} in room ${oldRoom?.index ?? 0}.`;
    }
  }
  if (selected.id === 'copier_route')
    record = `DECLINED ROUTE\n${pick(rng, declined)}\nAnnotation: inspect the illuminated copy tray twice.`;
  room.props = placed.filter((p) => p !== anchor);
  const door = pick(
    rng,
    room.layout.doors.filter((d) => !d.entrance),
  );
  room.anomaly = { id: selected.id, anchor, doorId: door.id, record };
  if (selected.id === 'blue_door') {
    door.color = '#2869bd';
    door.label = 'RETURNS';
    room.narrator.doors[door.id] = selected.line;
    if (
      room.rule?.id === 'narrator_suggests' &&
      room.rule.params.door === door.id
    )
      room.rule.line = 'Take the door marked RETURNS. Trust me.';
  }
  if (selected.id === 'false_exit') door.concealed = true;
}

/** Core owns interaction stages. Rendering receives JSON effects and never awards consequences. */
export class AnomalyRuntime {
  private stage = 0;
  private noticed = false;
  constructor(
    private room: RoomSpec,
    private events: GameEvent[],
    private emit: (effect: AnomalyEffect) => void,
    private say: (line: string) => void,
    private borrow: (t: number) => boolean,
  ) {}

  onEvent(e: GameEvent) {
    const a = this.room.anomaly;
    if (!a || !('roomId' in e) || e.roomId !== this.room.id) return;
    const def = definition(a.id);
    if (
      e.type === 'door_chosen' &&
      a.id === 'blue_door' &&
      e.doorId === a.doorId
    ) {
      this.say(def.done);
      return;
    }
    if (
      e.type === 'looked_at' &&
      e.objectId === `anomaly:${a.id}` &&
      e.seconds >= 2.5 &&
      a.id === 'borrowed_clock' &&
      !this.noticed
    ) {
      if (this.borrow(e.t)) {
        this.noticed = true;
        this.stage = 1;
        this.say(def.line);
        this.effect('Eight seconds have been added to the countdown.');
      }
      return;
    }
    if (e.type !== 'anomaly_action' || e.anomalyId !== a.id) return;
    if (
      e.action !== 'use' &&
      !(a.id === 'permission_machine' && e.action === 'stay') &&
      !(a.id === 'footprints' && e.action === 'erase')
    )
      return;
    if (a.id === 'footprints') {
      if (e.action === 'erase' && !this.noticed) {
        this.noticed = true;
        this.say(def.line);
      }
      if (e.action === 'use')
        this.effect(
          'ATTENDANCE POLICY\nWalk to register your steps. Retrace your path to withdraw them.',
        );
      return;
    }
    if (a.id === 'borrowed_clock') {
      this.effect(
        'TIME ON CREDIT\nWatch the hands for three seconds while the countdown is running. One loan per visit.',
      );
      return;
    }
    const max = [
      'ceiling_cabinet',
      'queue_plant',
      'copier_route',
      'hold_phone',
      'weather_drawer',
    ].includes(a.id)
      ? 2
      : 1;
    if (this.stage >= max) {
      this.effect(this.receipt(e.t) || a.record);
      return;
    }
    this.stage++;
    const second = this.stage === 2 || e.action === 'stay';
    this.say(second ? def.done : def.line);
    let text = a.record;
    if (a.id === 'reflection') text = 'You settle into the chair. The reflected chair takes a moment to catch up.';
    if (a.id === 'wandering_light') text = 'UNDER-DESK NOTE\nThey listen through the lights.';
    if (a.id === 'shadow_divider') text = 'The screen folds away. A silhouette remains on the wall, then walks out of the meeting.';
    if (a.id === 'receipt') text = this.receipt(e.t);
    if (a.id === 'hold_phone')
      text =
        this.stage === 1
          ? 'The receiver is playing the narrator’s hold message. Use it again to hang up.'
          : 'The call has ended.';
    if (a.id === 'weather_drawer')
      text =
        this.stage === 1
          ? 'Rain is spilling out. Use again to slide the wastebasket beneath it.'
          : 'The wastebasket catches the rain.';
    if (a.id === 'queue_plant')
      text = `Ticket ${this.stage}. The ficus advances toward the window.`;
    if (a.id === 'ceiling_cabinet')
      text =
        this.stage === 1
          ? 'A memo falls from the drawer. Use again to read it.'
          : `MISFILED MEMO\n${a.record}`;
    if (a.id === 'permission_machine')
      text =
        e.action === 'stay'
          ? 'PERMISSION TO STAY\nYour break has been extended.'
          : 'PERMISSION TO LEAVE\nFollow the illuminated door.';
    if (a.id === 'disputed_ticket') text = `DISPUTED\n${a.record}`;
    if (a.id === 'false_exit')
      text = 'The light goes out. A concealed exit is now visible.';
    this.emit({
      roomId: this.room.id,
      stage: this.stage,
      text,
      choice: e.action,
    });
  }

  private effect(text: string) {
    this.emit({ roomId: this.room.id, stage: this.stage, text });
  }
  private receipt(t: number): string {
    if (this.room.anomaly?.id !== 'receipt') return '';
    const mine = this.events.filter(
      (e) => 'roomId' in e && e.roomId === this.room.id,
    );
    const entered = mine.find((e) => e.type === 'room_entered')?.t ?? t;
    return `VISIT RECEIPT\nTime: ${Math.round(t - entered)} seconds\nInspections: ${mine.filter((e) => e.type === 'inspected').length}\nLocked door attempts: ${mine.filter((e) => e.type === 'door_tried').length}\nAmount due: your attention`;
  }
}
