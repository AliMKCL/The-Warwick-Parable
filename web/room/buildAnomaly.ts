import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { definition } from '../../core/anomalies/catalog';
import type { AnomalyEffect } from '../../core/protocol';
import type { GameData, RoomSpec } from '../../core/room/types';
import { buildProp, type InteractInfo } from './buildProp';
import type { DoorView } from './buildRoom';
import type { MaterialLibrary } from './materials';
import { textMaterial } from './textTexture';

type Owned = { dispose(): void }[];
export interface AnomalyView {
  apply(effect: AnomalyEffect): void;
  update(
    dt: number,
    t: number,
    player: THREE.Vector3,
    hovered?: string,
  ): boolean;
}

/** Each encounter fits inside a validated wall slot. All temporary GPU resources belong to its room. */
export function buildAnomaly(
  spec: RoomSpec,
  data: GameData,
  library: MaterialLibrary,
  room: THREE.Group,
  doors: DoorView[],
  owned: Owned,
): AnomalyView {
  const a = spec.anomaly!;
  const def = definition(a.id);
  const root = new THREE.Group();
  root.name = `anomaly:${a.id}`;
  root.position.set(a.anchor.x, 0, a.anchor.z);
  root.rotation.y = a.anchor.rotY;
  root.userData.interact = {
    kind: 'anomaly',
    id: root.name,
    name: def.action,
  } satisfies InteractInfo;
  room.add(root);
  let stage = 0,
    elapsed = 0,
    changedAt = 0;
  const moving = new THREE.Group();
  root.add(moving);
  const trim = material('#35423e');
  const cream = material('#d7d3bf');
  const dark = material('#202a29');
  const paper = material('#f4ecd4');
  const blue = material('#2b70b0');
  const rainMat = material('#83c9eb', true);
  const droplets: THREE.Mesh[] = [];
  let note: THREE.Object3D | undefined;
  let hand: THREE.Object3D | undefined;
  let reflectedChair: THREE.Object3D | undefined;
  let realChair: THREE.Object3D | undefined;
  let basket: THREE.Object3D | undefined;
  let sign: THREE.Mesh | undefined;
  let phone: THREE.Object3D | undefined;
  let breakSeat: THREE.Object3D | undefined;
  const footprints: THREE.Mesh[] = [];
  let lastStep = new THREE.Vector3(-100, 0, -100);
  let stepNumber = 0;
  let erasedReported = false;
  owned.push({
    dispose() {
      for (const mesh of footprints) {
        mesh.geometry.dispose();
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.map?.dispose();
        m.dispose();
      }
    },
  });

  function material(color: string, glow = false) {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      emissive: glow ? color : '#000000',
      emissiveIntensity: glow ? 0.7 : 0,
    });
    owned.push(m);
    return m;
  }
  function box(
    parent: THREE.Object3D,
    size: [number, number, number],
    pos: [number, number, number],
    mat = cream,
  ) {
    const g = new THREE.BoxGeometry(...size);
    owned.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(...pos);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function text(
    parent: THREE.Object3D,
    value: string,
    pos: [number, number, number],
    size: [number, number] = [0.7, 0.3],
  ) {
    const m = textMaterial(value, 'paper', size);
    const g = new THREE.PlaneGeometry(...size);
    owned.push(g, m, m.map!);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(...pos);
    parent.add(mesh);
    return mesh;
  }
  function prop(id: string, parent: THREE.Object3D, scale = 1) {
    const recipe = data.props.find((p) => p.id === id)!;
    const built = buildProp(
      { id: root.name, recipe: id, slot: '', x: 0, y: 0, z: 0, rotY: 0 },
      recipe,
      library,
    );
    delete built.object.userData.interact;
    built.object.scale.setScalar(scale);
    owned.push(...built.owned);
    parent.add(built.object);
    return built.object;
  }
  function chair(parent: THREE.Object3D, x: number, z: number, scale = 1) {
    const g = new THREE.Group();
    box(g, [0.42, 0.07, 0.4], [0, 0.43, 0], dark);
    box(g, [0.42, 0.42, 0.06], [0, 0.67, -0.17], dark);
    for (const px of [-0.16, 0.16])
      for (const pz of [-0.14, 0.14])
        box(g, [0.025, 0.42, 0.025], [px, 0.21, pz], trim);
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    parent.add(g);
    return g;
  }
  function plaque(value: string) {
    box(root, [0.84, 0.38, 0.04], [0, 1.75, -0.35], trim);
    return text(root, value, [0, 1.75, -0.323], [0.78, 0.32]);
  }
  function cabinet() {
    box(root, [0.76, 1.1, 0.58], [0, 0.55, -0.06], trim);
    for (const y of [0.25, 0.57, 0.89]) {
      const face = box(
        y === 0.89 ? moving : root,
        [0.68, 0.26, 0.04],
        [0, y, 0.25],
        cream,
      );
      box(face, [0.18, 0.025, 0.04], [0, 0, 0.04], dark);
    }
  }

  switch (a.id) {
    case 'blue_door':
      plaque('RETURNS DESK');
      box(root, [0.76, 0.08, 0.65], [0, 0.8, 0]);
      box(root, [0.12, 0.8, 0.12], [0, 0.4, 0], trim);
      text(root, a.record, [0, 1.2, 0.12], [0.7, 0.45]);
      break;
    case 'ceiling_cabinet': {
      const c = prop('filing_cabinet', moving, 0.62);
      c.position.y = spec.layout.ceiling - 0.85;
      box(
        root,
        [0.012, spec.layout.ceiling - 1.4, 0.012],
        [0, (spec.layout.ceiling + 1.15) / 2 - 0.2, 0.22],
        dark,
      );
      box(root, [0.28, 0.04, 0.07], [0, 1.2, 0.22], trim);
      note = text(
        root,
        'MISFILED\n' + a.record,
        [0, spec.layout.ceiling - 0.4, 0.3],
        [0.5, 0.34],
      );
      note.visible = false;
      break;
    }
    case 'false_exit':
      plaque('EXIT →');
      box(root, [0.16, 0.25, 0.08], [0, 1.15, -0.3], cream);
      box(moving, [0.05, 0.1, 0.05], [0, 1.15, -0.24], dark);
      text(root, 'EMERGENCY LIGHT', [0, 1.4, -0.28], [0.65, 0.13]);
      break;
    case 'footprints':
      plaque('ATTENDANCE\nREGISTERED UNDERFOOT');
      text(root, 'Retrace to withdraw', [0, 1.3, -0.3], [0.7, 0.2]);
      break;
    case 'floor_meeting': {
      const table = box(root, [0.76, 0.035, 0.55], [0, 0.023, 0], trim);
      table.receiveShadow = true;
      const agenda = text(
        root,
        'AGENDA\n' + a.record,
        [0, 0.045, 0],
        [0.6, 0.36],
      );
      agenda.rotation.x = -Math.PI / 2;
      chair(root, -0.29, -0.18, 0.42);
      chair(root, 0.29, -0.18, 0.42);
      plaque('MEETING IN PROGRESS ↓');
      break;
    }
    case 'reflection': {
      box(root, [0.87, 1.5, 0.05], [0, 1.23, -0.36], trim);
      const geo = new THREE.PlaneGeometry(0.79, 1.42);
      const mirror = new Reflector(geo, {
        color: 0xa7b7ac,
        textureWidth: 512,
        textureHeight: 512,
        clipBias: 0.003,
      });
      mirror.position.set(0, 1.23, -0.327);
      root.add(mirror);
      owned.push(geo, { dispose: () => mirror.dispose() });
      realChair = chair(root, 0, 0.18, 0.8);
      reflectedChair = chair(root, 0, -0.27, 0.55);
      reflectedChair.scale.z = 0.03;
      reflectedChair.position.y = 0.65;
      break;
    }
    case 'queue_plant':
      plaque('NOW SERVING\nFICUS');
      prop('plant_dead', moving, 0.6).position.set(-0.18, 0, 0.22);
      box(root, [0.28, 0.7, 0.3], [0.25, 0.35, 0.13], trim);
      text(root, 'TAKE\nTICKET', [0.25, 0.72, 0.29], [0.25, 0.25]);
      box(root, [0.7, 0.04, 0.3], [0, 0.95, -0.22], cream);
      break;
    case 'borrowed_clock': {
      plaque('TIME ON CREDIT\nWatch to borrow');
      const geo = new THREE.CircleGeometry(0.33, 40);
      owned.push(geo);
      const face = new THREE.Mesh(geo, paper);
      face.position.set(0, 1.12, -0.26);
      root.add(face);
      text(root, '12\n\n6', [0, 1.12, -0.24], [0.22, 0.57]);
      hand = new THREE.Group();
      hand.position.set(0, 1.12, -0.22);
      box(hand, [0.018, 0.27, 0.012], [0, 0.115, 0], dark);
      root.add(hand);
      break;
    }
    case 'disputed_ticket':
      plaque('RETROSPECTIVE SERVICE');
      box(root, [0.75, 0.1, 0.65], [0, 0.83, 0], trim);
      box(root, [0.5, 0.8, 0.4], [0, 0.4, 0], cream);
      note = text(root, a.record, [0, 1.1, 0.26], [0.69, 0.4]);
      box(moving, [0.14, 0.16, 0.12], [0.25, 0.97, 0], blue);
      sign = text(root, 'DISPUTED', [0, 1.1, 0.28], [0.6, 0.15]);
      sign.visible = false;
      break;
    case 'copier_route':
      prop('copier', root, 0.65);
      plaque('UNTAKEN ROUTES');
      note = text(moving, a.record, [0, 0.95, 0.32], [0.7, 0.42]);
      break;
    case 'wandering_light': {
      box(root, [0.8, 0.07, 0.65], [0, 0.9, 0], trim);
      for (const x of [-0.33, 0.33])
        box(root, [0.05, 0.9, 0.05], [x, 0.45, 0], trim);
      note = text(
        root,
        'BREAK ROOM\nThey listen through the lights.',
        [0, 0.48, -0.1],
        [0.6, 0.3],
      );
      const glow = box(
        moving,
        [0.5, 0.012, 0.4],
        [0, 0.018, 0],
        material('#e5efb1', true),
      );
      glow.castShadow = false;
      const light = new THREE.PointLight('#f4efb2', 1.6, 2);
      light.position.set(0, 0.24, 0);
      moving.add(light);
      owned.push(light);
      plaque('LIGHTING ON BREAK');
      break;
    }
    case 'hold_phone':
      box(root, [0.06, 1.8, 0.06], [0, 0.9, 0], trim);
      box(root, [0.65, 0.05, 0.35], [0, 0.04, 0], trim);
      box(root, [0.4, 0.04, 0.05], [0, 1.5, 0], trim);
      phone = box(moving, [0.08, 0.32, 0.1], [0.2, 1.3, 0.08], dark);
      box(phone, [0.13, 0.08, 0.12], [0, 0.13, 0.02], dark);
      box(phone, [0.13, 0.08, 0.12], [0, -0.13, 0.02], dark);
      text(root, 'PLEASE HOLD', [0, 1.85, 0.03], [0.7, 0.2]);
      break;
    case 'weather_drawer':
      cabinet();
      basket = prop('trash_bin', root, 0.6);
      basket.position.set(-0.29, 0, 0.22);
      for (let i = 0; i < 30; i++) {
        const drop = box(
          root,
          [0.008, 0.055, 0.008],
          [((i * 7) % 23) / 70 - 0.16, 0.9, 0.32],
          rainMat,
        );
        drop.visible = false;
        droplets.push(drop);
      }
      plaque('APRIL / UNRESOLVED');
      break;
    case 'permission_machine': {
      prop('vending_machine', root, 0.6);
      plaque('ONE FREE PERMISSION');
      const leave = text(root, 'LEAVE', [-0.2, 1.05, 0.4], [0.32, 0.2]);
      leave.userData.interact = {
        kind: 'anomaly',
        id: root.name,
        name: def.action,
        action: 'use',
      } satisfies InteractInfo;
      const stay = text(root, 'STAY', [0.2, 1.05, 0.4], [0.32, 0.2]);
      stay.userData.interact = {
        kind: 'anomaly',
        id: root.name + ':stay',
        name: 'Choose PERMISSION TO STAY',
        action: 'stay',
      } satisfies InteractInfo;
      note = text(root, 'BREAK APPROVED', [0, 1.36, 0.4], [0.65, 0.22]);
      note.visible = false;
      breakSeat = box(root, [0.7, 0.07, 0.32], [0, 0.45, 0.24], cream);
      breakSeat.visible = false;
      break;
    }
    case 'receipt':
      plaque('VISIT EXPENSES');
      box(root, [0.5, 0.05, 0.07], [0, 1.15, -0.3], dark);
      note = text(root, 'VISIT RECEIPT', [0, 0.9, -0.25], [0.42, 0.5]);
      note.visible = false;
      break;
    case 'shadow_divider': {
      for (let i = -1; i <= 1; i++) {
        const panel = box(
          moving,
          [0.27, 1.65, 0.035],
          [i * 0.27, 0.825, 0.24],
          cream,
        );
        panel.rotation.y = i * 0.25;
      }
      // A silhouette on the wall remains after the screen folds, then departs.
      const shadow = new THREE.Group();
      box(shadow, [0.2, 0.65, 0.012], [0, 0.96, 0], dark);
      const headGeo = new THREE.SphereGeometry(0.12, 16, 10);
      owned.push(headGeo);
      const head = new THREE.Mesh(headGeo, dark);
      head.scale.z = 0.08;
      head.position.y = 1.43;
      shadow.add(head);
      for (const x of [-0.06, 0.06])
        box(shadow, [0.06, 0.6, 0.012], [x, 0.35, 0], dark);
      shadow.position.z = -0.38;
      root.add(shadow);
      note = shadow;
      break;
    }
  }

  return {
    apply(effect) {
      if (effect.stage !== stage) changedAt = elapsed;
      stage = effect.stage;
      if (a.id === 'false_exit' && stage > 0) {
        const door = doors.find((d) => d.door.id === a.doorId);
        const cover = door?.pivot.parent?.getObjectByName('concealed-exit');
        if (cover) cover.visible = false;
        if (door?.indicator) door.indicator.emissive.set('#baffeb');
      }
      if (a.id === 'permission_machine' && stage > 0) {
        if (note) note.visible = effect.choice === 'stay';
        if (breakSeat) breakSeat.visible = effect.choice === 'stay';
        const door = doors.find((d) => d.door.id === a.doorId);
        if (door?.indicator && effect.choice !== 'stay') {
          door.indicator.emissive.set('#49d9ff');
          door.indicator.emissiveIntensity = 5;
        }
      }
      if (sign) sign.visible = stage > 0;
      if (note && ['receipt', 'ceiling_cabinet'].includes(a.id))
        note.visible = stage > 0;
      if (a.id === 'receipt' && note instanceof THREE.Mesh) {
        const m = textMaterial(effect.text, 'paper', [0.42, 0.5]);
        owned.push(m, m.map!);
        note.material = m;
      }
      if (a.id === 'hold_phone')
        root.userData.interact.name =
          stage === 1 ? 'Hang up the receiver' : 'Read the call record';
      if (a.id === 'weather_drawer')
        root.userData.interact.name =
          stage === 1
            ? 'Slide the wastebasket beneath the rain'
            : 'Inspect the contained weather';
      if (a.id === 'ceiling_cabinet')
        root.userData.interact.name = 'Read the fallen memo';
    },
    update(dt, _t, player, hovered) {
      elapsed += dt;
      const since = elapsed - changedAt;
      const blend = Math.min(1, since * 1.8);
      switch (a.id) {
        case 'ceiling_cabinet':
          moving.position.z = stage > 0 ? blend * 0.1 : 0;
          if (note && stage > 0)
            note.position.y = THREE.MathUtils.lerp(
              spec.layout.ceiling - 0.4,
              0.18,
              Math.min(1, since * 0.8),
            );
          break;
        case 'queue_plant':
          moving.position.z +=
            (-stage * 0.13 - moving.position.z) * Math.min(1, dt * 3);
          break;
        case 'borrowed_clock':
          if (hand)
            hand.rotation.z += dt * (hovered === root.name ? 1.8 : -0.3);
          break;
        case 'reflection':
          if (realChair && stage > 0)
            realChair.position.z = 0.18 + blend * 0.04;
          if (reflectedChair)
            reflectedChair.position.y = stage
              ? 0.65 - Math.min(0.2, Math.max(0, since - 0.7) * 0.3)
              : 0.7 + Math.sin(elapsed * 0.7) * 0.08;
          break;
        case 'copier_route':
          if (stage > 0) moving.position.y = blend * 0.13;
          break;
        case 'wandering_light':
          moving.position.x = Math.sin(elapsed * 0.55) * 0.28;
          moving.position.z = (1 + Math.cos(elapsed * 0.55)) * 1.1;
          if (note) note.visible = Math.cos(elapsed * 0.55) < 0;
          break;
        case 'hold_phone':
          moving.position.y +=
            ((stage === 1 ? 0.25 : 0) - moving.position.y) *
            Math.min(1, dt * 4);
          break;
        case 'weather_drawer':
          moving.position.z = stage ? blend * 0.12 : 0;
          if (basket && stage === 2)
            basket.position.x += (0 - basket.position.x) * Math.min(1, dt * 3);
          droplets.forEach((drop, i) => {
            drop.visible = stage > 0;
            drop.position.y =
              0.82 - ((elapsed * 0.7 + i * 0.027) % (stage === 2 ? 0.55 : 0.8));
          });
          break;
        case 'shadow_divider':
          if (stage) {
            moving.scale.x = 1 - blend * 0.9;
            moving.position.x = -blend * 0.34;
          }
          if (note && stage) {
            note.position.x = Math.max(0, since - 2) * 0.3;
            note.visible = since < 4.8;
          }
          break;
        case 'footprints': {
          const previous = footprints.at(-2);
          if (
            previous &&
            Math.hypot(
              player.x - previous.position.x,
              player.z - previous.position.z,
            ) < 0.3
          ) {
            const removed = footprints.pop()!;
            room.remove(removed);
            removed.geometry.dispose();
            const m = removed.material as THREE.MeshStandardMaterial;
            m.map?.dispose();
            m.dispose();
            stepNumber = Math.max(0, stepNumber - 1);
            lastStep.copy(player);
            if (!erasedReported) {
              erasedReported = true;
              return true;
            }
          } else if (
            player.distanceTo(lastStep) > 0.65 &&
            footprints.length < 100
          ) {
            const mat = textMaterial(
              String(++stepNumber),
              'label',
              [0.2, 0.32],
            );
            const geo = new THREE.PlaneGeometry(0.2, 0.32);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(player.x, 0.008, player.z);
            mesh.rotation.x = -Math.PI / 2;
            room.add(mesh);
            footprints.push(mesh);
            lastStep.copy(player);
          }
          break;
        }
      }
      return false;
    },
  };
}
