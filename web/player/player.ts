import * as THREE from 'three';
import type { Rect } from '../room/buildRoom';

const EYE = 1.62, RADIUS = 0.28, SPEED = 2.7, SENS = 0.0022;

/** First-person walker: mouse look, WASD, and circle-vs-box collision against the room grid and solid props. */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  private keys = new Set<string>();
  private bob = 0;
  /** Seconds since the player last moved or looked around. */
  stillFor = 0;
  /** Seconds since the player last walked (looking around doesn't count). */
  standingFor = 0;
  /** Set for one frame each time a foot lands. */
  stepped = false;
  enabled = false;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 80);
    this.camera.rotation.order = 'YXZ';
    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  look(dx: number, dy: number) {
    if (!this.enabled) return;
    this.yaw -= dx * SENS;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * SENS));
    if (Math.abs(dx) + Math.abs(dy) > 2) this.stillFor = 0;
  }

  placeAt(x: number, z: number, yaw: number) {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.stillFor = 0;
    this.standingFor = 0;
    this.sync();
  }

  update(dt: number, walkable: (cx: number, cz: number) => boolean, colliders: Rect[]) {
    let fx = 0, fz = 0;
    if (this.enabled) {
      const k = this.keys;
      if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    }
    const len = Math.hypot(fx, fz);
    if (len > 0) {
      fx /= len; fz /= len;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const mx = (fx * cos + fz * sin) * SPEED * dt;
      const mz = (-fx * sin + fz * cos) * SPEED * dt;
      // Resolve each axis separately so the player slides along walls.
      if (!this.blocked(this.position.x + mx, this.position.z, walkable, colliders)) this.position.x += mx;
      if (!this.blocked(this.position.x, this.position.z + mz, walkable, colliders)) this.position.z += mz;
      const before = Math.floor(this.bob / Math.PI);
      this.bob += dt * 8.5;
      this.stepped = Math.floor(this.bob / Math.PI) !== before;
      this.stillFor = 0;
      this.standingFor = 0;
    } else {
      this.stepped = false;
      this.bob *= 0.9;
      this.stillFor += dt;
      this.standingFor += dt;
    }
    this.sync();
  }

  private sync() {
    this.camera.position.set(this.position.x, EYE + Math.sin(this.bob) * 0.025, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private blocked(x: number, z: number, walkable: (cx: number, cz: number) => boolean, colliders: Rect[]): boolean {
    for (let cz = Math.floor(z - RADIUS); cz <= Math.floor(z + RADIUS); cz++) {
      for (let cx = Math.floor(x - RADIUS); cx <= Math.floor(x + RADIUS); cx++) {
        if (!walkable(cx, cz) && circleHitsRect(x, z, { minX: cx, maxX: cx + 1, minZ: cz, maxZ: cz + 1 })) return true;
      }
    }
    return colliders.some((r) => circleHitsRect(x, z, r));
  }
}

function circleHitsRect(x: number, z: number, r: Rect): boolean {
  const nx = Math.max(r.minX, Math.min(x, r.maxX));
  const nz = Math.max(r.minZ, Math.min(z, r.maxZ));
  return (x - nx) ** 2 + (z - nz) ** 2 < RADIUS * RADIUS;
}
