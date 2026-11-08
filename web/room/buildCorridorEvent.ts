import * as THREE from 'three';
import type { RoomSpec } from '../../core/room/types';
import type { CorridorEventKind } from '../../core/corridors/corridor';
import { DIR, OPPOSITE, yawForFacing } from '../../core/room/geometry';
import { createRng, deriveSeed } from '../../core/util/random';

export interface CorridorEventView {
  /** Returns the event once when the player approaches. No timers or gameplay blockers. */
  update(dt: number, player: { x: number; z: number }): CorridorEventKind | undefined;
}

export function buildCorridorEvent(spec: RoomSpec, parent: THREE.Group, owned: { dispose(): void }[]): CorridorEventView | undefined {
  const event = spec.corridor?.event;
  if (!event) return;
  const rng = createRng(deriveSeed(spec.seed, 'corridor-event-animation'));
  const [dx, dz] = DIR[event.side];
  const root = new THREE.Group();
  root.name = `corridor-event:${event.kind}`;
  root.position.set(event.cx + 0.5 + dx * 0.5, 0, event.cz + 0.5 + dz * 0.5);
  root.rotation.y = yawForFacing(OPPOSITE[event.side]);
  parent.add(root);
  const material = (color: string, transparent = false) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.65, side: THREE.DoubleSide, transparent, opacity: transparent ? 0.7 : 1 });
    owned.push(m); return m;
  };
  const paper = material('#f1e6c8'), ink = material('#53636a'), wood = material('#62412e'), glass = material('#b2deed', true);
  const box = (w: number, h: number, d: number, mat: THREE.Material, target = root) => {
    const geo = new THREE.BoxGeometry(w, h, d); owned.push(geo);
    const mesh = new THREE.Mesh(geo, mat); target.add(mesh); return mesh;
  };
  let pane: THREE.Mesh | undefined;
  let picture: THREE.Group | undefined;
  const particles: { mesh: THREE.Mesh; x: number; y: number; vx: number; vy: number; vz: number; spin: number }[] = [];
  if (event.kind === 'falling_art') {
    picture = new THREE.Group(); picture.position.set(0, 1.7, 0.06); root.add(picture);
    box(0.95, 0.72, 0.06, wood, picture);
    box(0.82, 0.59, 0.015, paper, picture).position.z = 0.04;
    for (let i = 0; i < 4; i++) {
      const stroke = box(0.08, 0.32 + rng() * 0.12, 0.01, ink, picture);
      stroke.position.set(-0.28 + i * 0.18, 0, 0.055); stroke.rotation.z = -0.25 + rng() * 0.5;
    }
    // The hook remains behind after the frame drops.
    box(0.025, 0.055, 0.035, ink).position.set(0, 2.08, 0.035);
  } else {
    if (event.kind === 'breaking_window') {
      pane = box(0.81, 1.23, 0.008, glass); pane.position.set(0, 1.745, -0.045);
    } else {
      box(0.72, 0.08, 0.45, wood).position.set(0, 0.72, 0.27);
    }
    for (let i = 0; i < 18; i++) {
      let mesh: THREE.Mesh;
      if (event.kind === 'breaking_window') {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.08, -0.07, 0, 0.1, -0.06, 0, 0, 0.12, 0], 3));
        geo.computeVertexNormals(); owned.push(geo); mesh = new THREE.Mesh(geo, glass); root.add(mesh); mesh.visible = false;
      } else mesh = box(0.21, 0.003, 0.29, i % 3 ? paper : ink);
      const x = (rng() - 0.5) * 0.65, y = event.kind === 'breaking_window' ? 1.2 + rng() * 1.1 : 0.77 + i * 0.004;
      mesh.position.set(x, y, 0.28);
      particles.push({ mesh, x, y, vx: (rng() - 0.5) * 1.3, vy: 0.7 + rng() * 1.4, vz: 0.5 + rng() * 0.7, spin: (rng() - 0.5) * 5 });
    }
  }
  let elapsed: number | undefined;
  return {
    update(dt, player) {
      let triggered: CorridorEventKind | undefined;
      // Trigger beside the forward approach, close enough to see/hear the event.
      const approachX = root.position.x - dx * 2.5, approachZ = root.position.z - dz * 2.5;
      if (elapsed === undefined && Math.hypot(player.x - approachX, player.z - approachZ) < 3.5) {
        elapsed = 0; triggered = event.kind;
        if (pane) pane.visible = false;
        particles.forEach((p) => { p.mesh.visible = true; });
      }
      if (elapsed === undefined || elapsed >= 4) return triggered;
      elapsed = Math.min(4, elapsed + dt);
      if (picture) {
        const t = Math.max(0, elapsed - 0.25);
        picture.position.y = Math.max(0.075, 1.7 - 4 * t * t);
        picture.position.z = 0.06 + Math.min(0.65, t * 0.8);
        picture.rotation.x = -Math.min(Math.PI / 2, t * 2.6);
        picture.rotation.z = elapsed < 0.25 ? Math.sin(elapsed * 40) * 0.08 : 0.05;
      }
      for (const p of particles) {
        const gravity = event.kind === 'paper_gust' ? 1.6 : 6;
        const t = Math.min(elapsed, (p.vy + Math.sqrt(p.vy * p.vy + 2 * gravity * (p.y - 0.03))) / gravity);
        p.mesh.position.set(p.x + p.vx * t, Math.max(0.03, p.y + p.vy * t - gravity * t * t / 2), 0.28 + p.vz * t);
        p.mesh.rotation.set(event.kind === 'paper_gust' ? Math.sin(t * 5) * 0.25 : t * p.spin, t * p.spin, 0);
        if (p.mesh.position.y <= 0.031) p.mesh.rotation.x = event.kind === 'paper_gust' ? 0 : -Math.PI / 2;
      }
      return triggered;
    },
  };
}
