import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHOICE_ROOM } from '../../core/room/layouts';
import { DIR, footprintRect, isFloor, OPPOSITE, yawForFacing } from '../../core/room/geometry';
import type { Door, GameData, RoomSpec, Side } from '../../core/room/types';
import { buildProp, type InteractInfo } from './buildProp';
import { MaterialLibrary, surfaceMaterials } from './materials';
import { ANOMALY_ANCHOR } from '../../core/anomalies/catalog';
import { buildAnomaly, type AnomalyView } from './buildAnomaly';
import { addMess, mountOnCeiling, planWallDetails, windowKey } from './dressRoom';
import { textMaterial } from './textTexture';

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

export interface DoorView {
  door: Door;
  pivot: THREE.Object3D;
  /** 0 closed, 1 open. */
  open: number;
  target: number;
  /** Sign of the hinge rotation that swings the door away from the room. */
  swing: number;
  locked: boolean;
  /** Small status light by the door: red when locked, green when open. */
  indicator?: THREE.MeshStandardMaterial;
  /** Decorative depth behind an unconnected door; hidden when a real passage is attached. */
  passage: THREE.Object3D;
}

export interface RoomView {
  spec: RoomSpec;
  anomaly?: AnomalyView;
  group: THREE.Group;
  colliders: Rect[];
  interactables: THREE.Object3D[];
  doors: DoorView[];
  fog: THREE.FogExp2;
  background: THREE.Color;
  exposure: number;
  grade?: { tint: [number, number, number]; contrast: number; vignette: number; grain: number };
  sound: string;
  /** True once after the lights flickered (for the buzz sound). */
  consumeFlicker(): boolean;
  update(dt: number, t: number): void;
  isWalkable(cx: number, cz: number): boolean;
  /** Fade all the room's lights to a level (0 dark, 1 normal) over some seconds. */
  setLights(level: number, seconds: number): void;
  lightLevel(): number;
  setLocked(doorIds: string[]): void;
  /** Redraw the text on a prop (the lift's floor indicator). */
  setPropText(propId: string, text: string): void;
  dispose(): void;
}

const DOOR_W = 0.9, DOOR_H = 2.1;

/** Turns a RoomSpec into Three.js objects. Everything the room owns is disposed with it. */
export function buildRoom(spec: RoomSpec, data: GameData, materials: MaterialLibrary, connectedEntrance = false): RoomView {
  const { layout } = spec;
  const H = layout.ceiling;
  const amb = data.ambience[spec.ambience] ?? Object.values(data.ambience)[0]!;
  const mats = surfaceMaterials(amb);
  const recipes = new Map(data.props.map((p) => [p.id, p]));
  const { windows, fixtures } = planWallDetails(spec, recipes);
  const owned: { dispose(): void }[] = Object.values(mats);
  const group = new THREE.Group();
  group.name = spec.id;

  const doorAt = new Map(layout.doors.map((d) => [`${d.cx},${d.cz},${d.side}`, d]));
  const wallQuads: THREE.BufferGeometry[] = [];
  const trimPieces: THREE.BufferGeometry[] = [];
  const floorQuads: THREE.BufferGeometry[] = [];
  const ceilQuads: THREE.BufferGeometry[] = [];
  const doors: DoorView[] = [];
  const interactables: THREE.Object3D[] = [];
  const windowPanes: THREE.BufferGeometry[] = [];
  const railPieces: THREE.BufferGeometry[] = [];
  const railMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(amb.wall).multiplyScalar(0.64), roughness: 0.84 });
  const paneMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
  owned.push(railMat, paneMat);

  for (let cz = 0; cz < layout.depth; cz++) {
    for (let cx = 0; cx < layout.width; cx++) {
      if (!isFloor(layout, cx, cz)) continue;
      floorQuads.push(quad(1, 1).rotateX(-Math.PI / 2).translate(cx + 0.5, 0, cz + 0.5));
      ceilQuads.push(quad(1, 1).rotateX(Math.PI / 2).translate(cx + 0.5, H, cz + 0.5));
      for (const side of ['n', 's', 'e', 'w'] as Side[]) {
        const [dx, dz] = DIR[side];
        if (isFloor(layout, cx + dx, cz + dz)) continue;
        const frame = wallFrame(cx, cz, side);
        const door = doorAt.get(`${cx},${cz},${side}`);
        if (door && !(layout.archetype === CHOICE_ROOM && door.entrance && !connectedEntrance)) {
          // Wall above the door, then the door itself.
          wallQuads.push(place(quad(1, H - DOOR_H - 0.06).translate(0, (H + DOOR_H + 0.06) / 2, 0), frame));
          wallQuads.push(place(quad(0.05, DOOR_H + 0.06).translate(-0.475, (DOOR_H + 0.06) / 2, 0), frame));
          wallQuads.push(place(quad(0.05, DOOR_H + 0.06).translate(0.475, (DOOR_H + 0.06) / 2, 0), frame));
          doors.push(buildDoor(door, frame));
        } else {
          const key = windowKey(cx, cz, side);
          if (windows.has(key)) {
            addWindow(frame);
          } else {
            wallQuads.push(place(quad(1, H).translate(0, H / 2, 0), frame));
          }
          trimPieces.push(place(new THREE.BoxGeometry(1, 0.09, 0.014).translate(0, 0.045, 0.007), frame));
          railPieces.push(place(new THREE.BoxGeometry(1, 0.065, 0.023).translate(0, 0.91, 0.012), frame));
          railPieces.push(place(new THREE.BoxGeometry(1, 0.048, 0.02).translate(0, H - 0.19, 0.01), frame));
          if (fixtures.has(key)) {
            railPieces.push(place(new THREE.BoxGeometry(0.23, 0.27, 0.04).translate(-0.18, 1.25, 0.025), frame));
            trimPieces.push(place(new THREE.BoxGeometry(0.03, 0.48, 0.024).translate(-0.18, 1.12, 0.035), frame));
            trimPieces.push(place(new THREE.BoxGeometry(0.1, 0.055, 0.014).translate(-0.18, 1.29, 0.051), frame));
          }
        }
      }
    }
  }

  const walls = mergedMesh(wallQuads, mats.wall);
  const floor = mergedMesh(floorQuads, mats.floor, 2);
  const ceiling = mergedMesh(ceilQuads, mats.ceiling, 2);
  const trim = mergedMesh(trimPieces, mats.trim);
  walls.receiveShadow = floor.receiveShadow = ceiling.receiveShadow = true;
  walls.castShadow = true;
  group.add(walls, floor, ceiling, trim, mergedMesh(railPieces, railMat));
  if (windowPanes.length) group.add(mergedMesh(windowPanes, paneMat));

  // ---- props ----
  const colliders: Rect[] = [];
  const propObjects = new Map<string, THREE.Object3D>();
  for (const placed of spec.props) {
    const recipe = recipes.get(placed.recipe);
    if (!recipe) continue;
    const { object, owned: o } = buildProp(placed, recipe, materials);
    owned.push(...o);
    if (spec.variant === 'ceiling') mountOnCeiling(object, H);
    group.add(object);
    propObjects.set(placed.id, object);
    if (object.userData.interact) interactables.push(object);
    if (spec.variant !== 'ceiling' && recipe.solid && !recipe.fits.every((f) => f === 'wall_mounted')) {
      colliders.push(footprintRect(placed.x, placed.z, placed.rotY, recipe.size[0], recipe.size[2]));
    }
  }
  for (const d of doors) interactables.push(d.pivot);

  const anomaly = spec.anomaly ? buildAnomaly(spec, data, materials, group, doors, owned) : undefined;
  if (spec.anomaly) {
    const a = spec.anomaly.anchor;
    colliders.push(footprintRect(a.x, a.z, a.rotY, ANOMALY_ANCHOR.size[0], ANOMALY_ANCHOR.size[2]));
  }

  if (spec.variant === 'messy') addMess(spec, group, colliders, owned);

  // ---- lights ----
  const panels: THREE.Mesh[] = [];
  const panelGeo = new THREE.PlaneGeometry(1.2, 0.6);
  owned.push(panelGeo);
  const panelCells: [number, number][] = [];
  for (let cz = 1; cz < layout.depth; cz += 3)
    for (let cx = 1; cx < layout.width; cx += 3) if (isFloor(layout, cx, cz)) panelCells.push([cx, cz]);
  if (!panelCells.length) panelCells.push([Math.floor(layout.width / 2), Math.floor(layout.depth / 2)]);
  for (const [cx, cz] of panelCells) {
    const p = new THREE.Mesh(panelGeo, mats.panel);
    p.rotation.x = Math.PI / 2;
    p.position.set(cx + 0.5, H - 0.004, cz + 0.5);
    group.add(p);
    panels.push(p);
  }
  const lightCells = spread(panelCells, Math.min(4, panelCells.length));
  const area = layout.width * layout.depth;
  const perLight = ((3.5 + area * 0.06) * amb.intensity) / Math.sqrt(lightCells.length);
  const points = lightCells.map(([cx, cz], i) => {
    const l = new THREE.PointLight(amb.light, perLight, 0, 2);
    l.position.set(cx + 0.5, H - 0.3, cz + 0.5);
    if (i === 0) {
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      l.shadow.bias = -0.002;
      l.shadow.radius = 4;
      l.shadow.camera.near = 0.1;
      l.shadow.camera.far = 20;
    }
    group.add(l);
    return l;
  });
  const hemi = new THREE.HemisphereLight(amb.sky, amb.ground, amb.hemi * 0.55);
  group.add(hemi);

  // ---- flicker and dimming ----
  let flickerLeft = 0;
  let flickerK = 1;
  let flickered = false;
  const baseLight = perLight;
  const basePanel = mats.panel.emissiveIntensity;
  const baseHemi = hemi.intensity;
  let level = 1, levelFrom = 1, levelTo = 1, levelT = 1, levelDur = 0;
  const applyLights = () => {
    const k = level * flickerK;
    mats.panel.emissiveIntensity = basePanel * Math.max(0.05, k);
    points.forEach((l) => (l.intensity = baseLight * k));
    hemi.intensity = baseHemi * (0.25 + 0.75 * level);
  };

  return {
    spec,
    anomaly,
    group,
    colliders,
    interactables,
    doors,
    fog: new THREE.FogExp2(amb.fog, amb.fogDensity),
    background: new THREE.Color(amb.fog),
    exposure: amb.exposure,
    grade: amb.grade,
    sound: amb.sound,
    consumeFlicker() {
      const f = flickered;
      flickered = false;
      return f;
    },
    isWalkable: (cx, cz) => isFloor(layout, cx, cz),
    setLights(to, seconds) {
      levelFrom = level;
      levelTo = to;
      levelT = 0;
      levelDur = Math.max(0.01, seconds);
    },
    lightLevel: () => level,
    setLocked(ids) {
      for (const d of doors) {
        if (d.door.entrance) continue;
        d.locked = ids.includes(d.door.id);
        d.indicator?.color.set(d.locked ? '#b3261e' : '#2f8f4e');
        d.indicator?.emissive.set(d.locked ? '#ff3b30' : '#34c759');
      }
    },
    setPropText(id, text) {
      const placed = spec.props.find((p) => p.id === id);
      const recipe = placed && recipes.get(placed.recipe);
      const plane = propObjects.get(id)?.userData.textPlane as THREE.Mesh | undefined;
      if (!plane || !recipe?.text) return;
      const old = plane.material as THREE.MeshStandardMaterial;
      const mat = textMaterial(text, recipe.text.style, recipe.text.size);
      plane.material = mat;
      owned.push(mat.map!, mat);
      old.map?.dispose();
      old.dispose();
    },
    update(dt) {
      if (levelT < 1) {
        levelT = Math.min(1, levelT + dt / levelDur);
        const e = levelT * levelT * (3 - 2 * levelT);
        level = levelFrom + (levelTo - levelFrom) * e;
        applyLights();
      }
      for (const d of doors) {
        d.open += (d.target - d.open) * Math.min(1, dt * 7);
        d.pivot.rotation.y = d.swing * d.open * 1.75;
      }
      if (flickerLeft <= 0 && Math.random() < amb.flicker * dt * 2.5) {
        flickerLeft = 0.08 + Math.random() * 0.25;
        flickered = true;
      }
      if (flickerLeft > 0) {
        flickerLeft -= dt;
        flickerK = Math.random() < 0.5 ? 0.25 : 0.9;
        if (flickerLeft <= 0) flickerK = 1;
        applyLights();
      }
    },
    dispose() {
      for (const o of owned) o.dispose();
      for (const l of points) l.dispose();
      hemi.dispose();
    },
  };

  // ---------- helpers (closures over owned) ----------

  function mergedMesh(parts: THREE.BufferGeometry[], mat: THREE.Material, uvScale?: number): THREE.Mesh {
    const geo = parts.length ? mergeGeometries(parts)! : new THREE.BufferGeometry();
    parts.forEach((p) => p.dispose());
    if (uvScale) worldUVs(geo, uvScale);
    owned.push(geo);
    return new THREE.Mesh(geo, mat);
  }

  function addWindow(frame: THREE.Matrix4) {
    const width = 0.84, bottom = 1.12, top = 2.37;
    const height = top - bottom, mid = (top + bottom) / 2;
    const margin = (1 - width) / 2;
    wallQuads.push(place(quad(1, bottom).translate(0, bottom / 2, 0), frame));
    wallQuads.push(place(quad(1, H - top).translate(0, (H + top) / 2, 0), frame));
    for (const sign of [-1, 1]) {
      wallQuads.push(place(quad(margin, height).translate(sign * (width + margin) / 2, mid, 0), frame));
      railPieces.push(place(new THREE.BoxGeometry(0.055, height + 0.1, 0.145)
        .translate(sign * width / 2, mid, -0.035), frame));
    }
    for (const y of [bottom, top]) {
      railPieces.push(place(new THREE.BoxGeometry(width + 0.055, 0.055, 0.145)
        .translate(0, y, -0.035), frame));
    }
    railPieces.push(place(new THREE.BoxGeometry(0.026, height, 0.12).translate(0, mid, -0.052), frame));
    railPieces.push(place(new THREE.BoxGeometry(width + 0.12, 0.035, 0.19).translate(0, bottom - 0.025, -0.012), frame));

    // The window has a sealed luminous backing. There is no exterior geometry.
    const pane = quad(width, height).translate(0, mid, -0.1);
    const upper = new THREE.Color('#ffffff'), lower = new THREE.Color('#bdd9e5');
    const colors = [...upper.toArray(), ...upper.toArray(), ...lower.toArray(), ...lower.toArray()];
    pane.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    windowPanes.push(place(pane, frame));
  }

  function buildDoor(door: Door, frame: THREE.Matrix4): DoorView {
    const root = new THREE.Group();
    root.applyMatrix4(frame);
    const frameMat = materials.get('door_frame');
    const leafMat = door.color || door.finale ? materials.get('door_paint').clone() : materials.get('door_paint');
    if (door.color) { leafMat.color.set(door.color); owned.push(leafMat); }
    if (door.finale) {
      // The way to the player's file: brighter and a little warmer than any door before it.
      leafMat.color.set('#f6e7c1');
      leafMat.emissive.set('#ffc865');
      leafMat.emissiveIntensity = 0.75;
      owned.push(leafMat);
    }
    for (const [w, h, x, y] of [
      [0.06, DOOR_H + 0.06, -0.48, (DOOR_H + 0.06) / 2],
      [0.06, DOOR_H + 0.06, 0.48, (DOOR_H + 0.06) / 2],
      [1.02, 0.07, 0, DOOR_H + 0.035],
    ] as const) {
      const g = new THREE.BoxGeometry(w, h, 0.16);
      owned.push(g);
      const m = new THREE.Mesh(g, frameMat);
      m.position.set(x, y, 0);
      m.castShadow = true;
      root.add(m);
    }
    // The leaf hangs from a hinge at local x = -0.45 and swings outward (-z).
    const pivot = new THREE.Group();
    pivot.position.set(-0.45, 0, -0.02);
    const leafGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.045);
    owned.push(leafGeo);
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.set(DOOR_W / 2, DOOR_H / 2, 0);
    leaf.castShadow = leaf.receiveShadow = true;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 12), materials.get('metal_light'));
    owned.push(handle.geometry);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(DOOR_W - 0.1, 1.0, 0.045);
    pivot.add(leaf, handle);
    root.add(pivot);
    if (door.concealed) {
      const cover = new THREE.Mesh(new THREE.BoxGeometry(1.04, 2.7, 0.08), mats.wall);
      cover.position.set(0, 1.35, 0.14);
      cover.name = 'concealed-exit';
      owned.push(cover.geometry);
      root.add(cover);
    }

    // Beyond the door: a dark passage, so an open door shows depth, not the void.
    const passageGeo = new THREE.BoxGeometry(1.0, DOOR_H + 0.06, 2.2);
    owned.push(passageGeo);
    const passage = new THREE.Mesh(passageGeo, new THREE.MeshBasicMaterial({ color: '#0a0a0a', side: THREE.BackSide }));
    owned.push(passage.material as THREE.Material);
    passage.position.set(0, (DOOR_H + 0.06) / 2, -1.12);
    root.add(passage);

    if (!door.entrance && door.label) {
      const mat = textMaterial(door.label, 'sign', [0.56, 0.17]);
      owned.push(mat.map!, mat);
      const plaqueGeo = new THREE.PlaneGeometry(0.56, 0.17);
      owned.push(plaqueGeo);
      const plaque = new THREE.Mesh(plaqueGeo, mat);
      if (layout.archetype === CHOICE_ROOM) {
        plaque.position.set(DOOR_W / 2, 1.56, 0.024);
        plaque.scale.set(1.35, 2.3, 1);
        pivot.add(plaque);
      } else {
        plaque.position.set(0, DOOR_H + 0.25, 0.006);
        root.add(plaque);
      }
    }

    if (door.finale) {
      // Warm light spilling round the frame and under the door, and onto the hallway in front of it.
      const glow = new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffd27a', emissiveIntensity: 3.2 });
      owned.push(glow);
      for (const [w, h, x, y] of [
        [0.012, DOOR_H, -0.452, DOOR_H / 2],
        [0.012, DOOR_H, 0.452, DOOR_H / 2],
        [0.9, 0.012, 0, DOOR_H + 0.004],
        [0.9, 0.018, 0, 0.009],
      ] as const) {
        const g = new THREE.BoxGeometry(w, h, 0.03);
        owned.push(g);
        const m = new THREE.Mesh(g, glow);
        m.position.set(x, y, 0.012);
        root.add(m);
      }
      const warm = new THREE.PointLight('#ffcf7a', 3.2, 7, 2);
      warm.position.set(0, 1.4, 0.8);
      root.add(warm);
    }

    let indicator: THREE.MeshStandardMaterial | undefined;
    if (!door.entrance && !door.finale) {
      indicator = new THREE.MeshStandardMaterial({ color: '#2f8f4e', emissive: '#34c759', emissiveIntensity: 1.4, roughness: 0.4 });
      const lampGeo = new THREE.BoxGeometry(0.06, 0.06, 0.02);
      owned.push(indicator, lampGeo);
      const lamp = new THREE.Mesh(lampGeo, indicator);
      lamp.position.set(0.62, 1.15, 0.012);
      root.add(lamp);
    }

    const info: InteractInfo = door.entrance
      ? { kind: 'locked', id: door.id, name: 'The way you came' }
      : { kind: 'door', id: door.id, name: door.label ? `door “${door.label}”` : 'door' };
    pivot.userData.interact = info;
    group.add(root);
    return { door, pivot, passage, open: 0, target: 0, swing: 1, locked: false, indicator };
  }
}

/** A plane of the given size, facing +z, centred at the origin. */
function quad(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}

/** Matrix taking local wall space (x along the wall, +z into the room) to the wall on `side` of the cell. */
function wallFrame(cx: number, cz: number, side: Side): THREE.Matrix4 {
  const inward = OPPOSITE[side];
  const [dx, dz] = DIR[side];
  const x = cx + 0.5 + dx * 0.5, z = cz + 0.5 + dz * 0.5;
  return new THREE.Matrix4().makeRotationY(yawForFacing(inward)).setPosition(x, 0, z);
}

function place(geo: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  return geo.applyMatrix4(m);
}

/** Replace UVs with world-space ones so tiled textures line up across merged quads. */
function worldUVs(geo: THREE.BufferGeometry, scale: number) {
  const pos = geo.getAttribute('position');
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) * scale;
    uv[i * 2 + 1] = pos.getZ(i) * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Pick n cells spread out across the room (farthest-point sampling). */
function spread(cells: [number, number][], n: number): [number, number][] {
  if (cells.length <= n) return cells;
  const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length;
  const cz = cells.reduce((a, c) => a + c[1], 0) / cells.length;
  const first = [...cells].sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz))[0]!;
  const out = [first];
  while (out.length < n) {
    let best = cells[0]!, bestD = -1;
    for (const c of cells) {
      const d = Math.min(...out.map((o) => Math.hypot(o[0] - c[0], o[1] - c[1])));
      if (d > bestD) { bestD = d; best = c; }
    }
    out.push(best);
  }
  return out;
}
