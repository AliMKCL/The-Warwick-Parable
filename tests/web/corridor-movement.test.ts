import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../web/game';
import { doorPoint } from '../../core/corridors/corridor';
import { DIR } from '../../core/room/geometry';
import type { Door } from '../../core/room/types';
import { fakeLlm } from '../core/fakeLlm';

// Exercise the real scene geometry, raycasts, Player collision and Game/Core lifecycle.
// Only GPU drawing, canvas lettering, sound and DOM presentation need browser substitutes.
vi.mock('../../web/render/renderer', () => ({ createRenderer: () => ({
  info: { autoReset: false, render: {}, reset() {} }, setPixelRatio() {}, setSize() {}, compile() {},
}) }));
vi.mock('../../web/room/materials', async (original) => {
  const actual = await original<typeof import('../../web/room/materials')>();
  return { ...actual, surfaceMaterials: () => Object.fromEntries(['wall', 'floor', 'ceiling', 'trim', 'panel', 'void'].map((key) => [key, new THREE.MeshStandardMaterial()])) };
});
vi.mock('../../web/room/textTexture', () => ({ textMaterial: () => new THREE.MeshStandardMaterial({ map: new THREE.Texture() }) }));
vi.mock('../../web/audio/sound', () => ({ Sound: class {
  start() {} doorOpen() {} rattle() {} button() {} rustle() {} footstep() {} buzz() {} tick() {} duck() {}
  setAmbience() {} setLightLevel() {} play() {}
} }));
vi.mock('../../web/audio/voice', () => ({ Voice: class { prefetch() {} speak() {} stop() {} setMuted() {} } }));
vi.mock('../../web/ui/dossier', () => ({ showDossier: vi.fn() }));
vi.mock('../../web/ui/hud', () => ({ Hud: class {
  start = { hidden: false }; inspecting = false;
  fade = vi.fn(async () => {}); waiting = vi.fn();
  narrate() {} timer() {} clearNarration() {} setPrompt() {}
  askOpen: unknown = null; ask() {} status() {} askAdjust() {} askPick() {} askAnswer() { return null; }
  showInspect() { this.inspecting = true; } hideInspect() { this.inspecting = false; }
} }));

let input: Map<string, ((e: { code: string }) => void)[]>;
beforeEach(() => {
  vi.useFakeTimers();
  input = new Map();
  vi.stubGlobal('addEventListener', (name: string, callback: (e: { code: string }) => void) => input.set(name, [...(input.get(name) ?? []), callback]));
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('__TTS__', { enabled: false });
  vi.stubGlobal('document', { getElementById: () => ({}), pointerLockElement: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function key(name: 'keydown' | 'keyup') { input.get(name)?.forEach((fn) => fn({ code: 'KeyW' })); }
function frames(g: Game, n = 1) {
  for (let i = 0; i < n; i++) {
    g.scene.updateMatrixWorld(true);
    g.player.camera.updateMatrixWorld(true);
    g.update(1 / 60, i / 60);
  }
}
function aim(g: Game, x: number, z: number, tx: number, y: number, tz: number) {
  g.player.placeAt(x, z, Math.atan2(-(tx - x), -(tz - z)));
  g.player.pitch = Math.atan2(y - 1.62, Math.hypot(tx - x, tz - z));
  frames(g, 2);
}
function walkTo(g: Game, x: number, z: number) {
  aim(g, g.player.position.x, g.player.position.z, x, 1.62, z);
  key('keydown');
  for (let i = 0; i < 1500 && Math.hypot(g.player.position.x - x, g.player.position.z - z) > 0.08; i++) frames(g);
  key('keyup');
  expect(Math.hypot(g.player.position.x - x, g.player.position.z - z), `walk to ${x},${z}`).toBeLessThan(0.1);
}
function faceDoor(g: Game, d: Door, ox = 0, oz = 0) {
  const { x, z } = doorPoint(d), [dx, dz] = DIR[d.side];
  aim(g, x + ox - dx * 0.8, z + oz - dz * 0.8, x + ox, 1.2, z + oz);
}

it.each([1, 7, 19, 20261107])('walks a full run with sealed return paths (seed %i)', async (seed) => {
  const g = new Game({ clientWidth: 960, clientHeight: 540 } as HTMLCanvasElement, {
    seed, post: false, maxDpr: 1, debug: false, mute: true, maxAnomalies: 0,
    layout: { tests: 1, fillers: 0, pool: ['choice'] },
  });
  g.begin();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  g.player.enabled = true;
  vi.mocked(g.hud.fade).mockClear();
  vi.mocked(g.hud.waiting).mockClear();
  for (let index = 0; index < 2; index++) {
    const from = g.room!, door = from.spec.layout.doors.find((d) => !d.entrance)!;
    faceDoor(g, door);
    expect(g.hovered?.info.kind).toBe('door');
    g.interact(); frames(g, 30);
    expect(g.core.run()!.rooms).toHaveLength(index + 1);
    const a = doorPoint(door), [dx, dz] = DIR[door.side];
    walkTo(g, a.x + dx * 1.1, a.z + dz * 1.1);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    frames(g, 60);
    const c = g.corridorState()!;
    expect(c.entered).toBe(true);
    expect(c.ready).toBe(true);
    expect(c.fromDisposed).toBe(true);
    expect(g.core.run()!.rooms).toHaveLength(index + 1);

    const entry = c.layout.doors.find((d) => d.entrance)!;
    faceDoor(g, entry, c.x, c.z);
    expect(g.hovered?.info.kind).toBe('locked');
    g.interact(); key('keydown'); frames(g, 90); key('keyup');
    const back = doorPoint(entry), [bx, bz] = DIR[entry.side];
    expect((g.player.position.x - back.x - c.x) * bx + (g.player.position.z - back.z - c.z) * bz).toBeLessThan(-0.27);

    for (const prop of c.props.filter((p) => ['receipt', 'archive', 'acknowledge'].includes(p.id))) {
      const id = prop.id;
      const x = c.x + prop.x, z = c.z + prop.z;
      aim(g, x + Math.sin(prop.rotY) * 1.2, z + Math.cos(prop.rotY) * 1.2, x, id === 'acknowledge' ? 1.03 : 1.5, z);
      expect(g.hovered?.info.id).toBe(id);
      const evidence = g.core.run()!.profile.evidence.length;
      g.interact();
      if (g.hud.inspecting) g.interact();
      expect(g.core.run()!.profile.evidence).toHaveLength(evidence);
    }

    // Traverse every floor cell of the shortest centre route using real movement/collision.
    g.player.placeAt(c.x + entry.cx + 0.5, c.z + entry.cz + 0.5, 0);
    const exit = c.layout.doors.find((d) => !d.entrance)!;
    const queue: number[][] = [[entry.cx, entry.cz]], prev = new Map<string, number[] | null>([[queue[0]!.join(','), null]]);
    while (queue.length) {
      const at = queue.shift()!;
      if (at[0] === exit.cx && at[1] === exit.cz) break;
      for (const [dx, dz] of Object.values(DIR)) {
        const p = [at[0]! + dx, at[1]! + dz], key = p.join(',');
        if (prev.has(key) || c.layout.cells[p[1]!]?.[p[0]!] !== '.') continue;
        prev.set(key, at); queue.push(p);
      }
    }
    const path: number[][] = [];
    let at: number[] | null = [exit.cx, exit.cz];
    while (at) { path.unshift(at); at = prev.get(at.join(',')) ?? null; }
    for (const p of path) walkTo(g, c.x + p[0]! + 0.5, c.z + p[1]! + 0.5);
    faceDoor(g, exit, c.x, c.z);
    expect(g.hovered?.info.id).toBe('onward');
    g.interact(); frames(g, 30);
    key('keydown');
    for (let i = 0; i < 120 && g.room === from; i++) frames(g);
    key('keyup'); frames(g, 60);
    expect(g.room!.spec.index).toBe(index + 1);
    expect(g.core.run()!.current!.id).toBe(g.room!.spec.id);
    expect(g.corridorState()).toBeUndefined();
    const inDoor = g.room!.spec.layout.doors.find((d) => d.entrance)!;
    faceDoor(g, inDoor);
    expect(g.hovered?.info.kind).toBe('locked');
    key('keydown'); frames(g, 90); key('keyup');
    const b = doorPoint(inDoor), [ix, iz] = DIR[inDoor.side];
    expect((g.player.position.x - b.x) * ix + (g.player.position.z - b.z) * iz).toBeLessThan(-0.27);
  }
  expect(g.room!.spec.layout.archetype).toBe('finale_hall');
  expect(g.hud.fade).not.toHaveBeenCalled();
  expect(g.hud.waiting).not.toHaveBeenCalled();
  expect(g.core.run()!.events.filter((e) => e.type === 'door_chosen')).toHaveLength(2);
  const finalDoor = g.room!.spec.layout.doors.find((d) => !d.entrance)!;
  faceDoor(g, finalDoor); g.interact();
  await vi.advanceTimersByTimeAsync(500);
  expect(g.ended).toBe(true);
  expect(g.dossier!.rooms).toHaveLength(3);
});

it.each([{ delayMs: 500, budget: 500, source: 'model' }, { delayMs: 60000, budget: 10000, source: 'template' }])('keeps the interlock playable, then opens automatically with $source content', async ({ delayMs, budget, source }) => {
  const g = new Game({ clientWidth: 960, clientHeight: 540 } as HTMLCanvasElement, {
    seed: 27, post: false, maxDpr: 1, debug: false, mute: true, maxAnomalies: 0,
    layout: { tests: 0, fillers: 1, pool: [] }, observeMs: 60000,
  });
  g.begin(fakeLlm({ delayMs }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  g.player.enabled = true;
  vi.mocked(g.hud.fade).mockClear();
  const from = g.room!, door = from.spec.layout.doors.find((d) => !d.entrance)!;
  faceDoor(g, door); g.interact(); frames(g, 30);
  const a = doorPoint(door), [dx, dz] = DIR[door.side];
  walkTo(g, a.x + dx * 1.1, a.z + dz * 1.1);
  frames(g, 60);
  const c = g.corridorState()!;
  expect(c.entered).toBe(true);
  expect(c.ready).toBe(false);
  const exit = c.layout.doors.find((d) => !d.entrance)!;
  faceDoor(g, exit, c.x, c.z); g.interact();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  frames(g, 40);
  expect(g.corridorState()!.exitOpen).toBe(0);
  expect(g.player.enabled).toBe(true);
  await vi.advanceTimersByTimeAsync(budget - 1);
  frames(g, 10);
  expect(g.corridorState()!.exitOpen).toBe(0);
  g.interact(); // pressing again must not restart the deadline
  await vi.advanceTimersByTimeAsync(1);
  frames(g, 40);
  expect(g.corridorState()!.exitOpen).toBeGreaterThan(0.85);
  key('keydown');
  for (let i = 0; i < 120 && g.room === from; i++) frames(g);
  key('keyup');
  expect(g.room!.spec.index).toBe(1);
  expect(g.room!.spec.source).toBe(source);
  expect(g.hud.fade).not.toHaveBeenCalled();
});
