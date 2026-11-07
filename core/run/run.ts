import { createRng, deriveSeed, pick } from '../util/random';
import { OPPOSITE } from '../room/geometry';
import { ARCHETYPES, generateLayout, type Archetype } from '../room/layouts';
import { placeAssignments } from '../room/place';
import { templateAssignments } from '../room/templates';
import type { GameData, RoomSpec } from '../room/types';
import type { GameEvent } from '../protocol';

/**
 * One playthrough. Holds the seed, the rooms visited and everything the
 * player did. Rooms are created only when the player walks through a door.
 *
 * Phase 2: rooms are filled from templates. Phase 3 adds model-written
 * content on the same layouts; Phase 4 lets the player profile steer them.
 */
export class Run {
  readonly rooms: RoomSpec[] = [];
  readonly events: GameEvent[] = [];

  constructor(
    readonly seed: number,
    private readonly data: GameData,
  ) {}

  get current(): RoomSpec | undefined {
    return this.rooms.at(-1);
  }

  start(): RoomSpec {
    return this.makeRoom({ archetype: 'waiting_room', entranceSide: 's', exits: 2, ambience: 'cold', first: true });
  }

  /** The player walked through `doorId` of the current room. */
  next(doorId: string): RoomSpec {
    const room = this.current;
    const door = room?.layout.doors.find((d) => d.id === doorId && !d.entrance);
    if (!room || !door) throw new Error(`No exit "${doorId}" in the current room`);
    const rng = createRng(deriveSeed(this.seed, `pick-${this.rooms.length}-${doorId}`));
    const archetype = pick(rng, ARCHETYPES.filter((a) => a !== room.layout.archetype)) as Archetype;
    const ambience = pick(rng, Object.keys(this.data.ambience));
    const exits = 1 + Math.floor(rng() * 3);
    return this.makeRoom({ archetype, entranceSide: OPPOSITE[door.side], exits, ambience, first: false });
  }

  record(event: GameEvent): void {
    this.events.push(event);
  }

  private makeRoom(o: {
    archetype: Archetype;
    entranceSide: RoomSpec['layout']['doors'][number]['side'];
    exits: number;
    ambience: string;
    first: boolean;
  }): RoomSpec {
    const index = this.rooms.length;
    const seed = deriveSeed(this.seed, `room-${index}-${this.current?.id ?? 'start'}`);
    const rng = createRng(seed);
    const layout = generateLayout({
      archetype: o.archetype,
      entranceSide: o.entranceSide,
      exits: o.exits,
      rng,
      doorLabels: this.data.templates.doorLabels,
    });
    const assignments = templateAssignments(layout, this.data, rng, {
      index,
      forceCenter: o.first ? 'button_pedestal' : undefined,
    });
    const { props } = placeAssignments(layout, assignments, this.data);
    const t = this.data.templates;
    const spec: RoomSpec = {
      id: `room-${index}-${seed.toString(36)}`,
      index,
      seed,
      layout,
      props,
      ambience: o.ambience,
      narrator: {
        onEnter: o.first ? pick(rng, t.narratorFirst) : pick(rng, t.narratorEnter[o.archetype] ?? t.narratorFirst),
        doors: Object.fromEntries(layout.doors.filter((d) => !d.entrance).map((d) => [d.id, pick(rng, t.narratorDoor)])),
      },
      source: 'template',
    };
    this.rooms.push(spec);
    return spec;
  }
}
