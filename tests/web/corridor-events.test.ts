import { expect, it } from 'vitest';
import * as THREE from 'three';
import { CORRIDOR_EVENTS, corridorStory, createCorridor } from '../../core/corridors/corridor';
import { gameData } from '../../core/data';
import { DIR } from '../../core/room/geometry';
import { Run } from '../../core/run/run';
import { buildCorridorEvent } from '../../web/room/buildCorridorEvent';

it.each(CORRIDOR_EVENTS)('%s triggers once, settles and owns all its graphics', (kind) => {
  const room = new Run(12, gameData).start(), door = room.layout.doors.find((d) => !d.entrance)!;
  const spec = createCorridor(room, door, corridorStory(room, door, [], gameData), gameData);
  const anchor = spec.corridor!.windows[0]!;
  spec.corridor!.event = { ...anchor, kind };
  const group = new THREE.Group(), owned: { dispose(): void }[] = [];
  const event = buildCorridorEvent(spec, group, owned)!;
  expect(owned.length).toBeGreaterThan(5);
  const root = group.children[0]!;
  const [dx, dz] = DIR[anchor.side];
  const near = { x: root.position.x - dx * 2.5, z: root.position.z - dz * 2.5 };
  expect(event.update(1, { x: 10000, z: 10000 })).toBeUndefined();
  expect(event.update(1 / 60, near)).toBe(kind);
  for (let i = 0; i < 300; i++) expect(event.update(1 / 60, near)).toBeUndefined();
  const settled = root.children.map((c) => c.position.toArray());
  event.update(1, near);
  expect(root.children.map((c) => c.position.toArray())).toEqual(settled);
  expect(settled.flat().every(Number.isFinite)).toBe(true);
  if (kind === 'falling_art') expect(root.children[0]!.position.y).toBeLessThan(0.1);
  if (kind === 'breaking_window') expect(root.children[0]!.visible).toBe(false);
  owned.forEach((r) => r.dispose());
});

it('builds no event graphics for quiet corridors or ordinary rooms', () => {
  const room = new Run(1, gameData).start(), group = new THREE.Group();
  expect(buildCorridorEvent(room, group, [])).toBeUndefined();
  const door = room.layout.doors.find((d) => !d.entrance)!;
  const spec = createCorridor(room, door, corridorStory(room, door, [], gameData), gameData);
  spec.corridor!.event = undefined;
  expect(buildCorridorEvent(spec, group, [])).toBeUndefined();
  expect(group.children).toHaveLength(0);
});
