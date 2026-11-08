import * as THREE from 'three';
import type { PlacedProp, PropPart, PropRecipe } from '../../core/room/types';
import type { MaterialLibrary } from './materials';
import { textMaterial } from './textTexture';

const DEG = Math.PI / 180;
const geometryCache = new Map<string, THREE.BufferGeometry>();

/** Shared geometry per shape and size; never disposed, since every room reuses it. */
function partGeometry(part: PropPart): THREE.BufferGeometry {
  const key = `${part.shape}:${part.size.join(',')}`;
  let g = geometryCache.get(key);
  if (g) return g;
  const s = part.size;
  switch (part.shape) {
    case 'box': g = new THREE.BoxGeometry(s[0], s[1], s[2]); break;
    case 'cyl': g = new THREE.CylinderGeometry(s[0], s[1], s[2], 28); break;
    case 'sphere': g = new THREE.SphereGeometry(s[0], 20, 14); break;
    case 'cone': g = new THREE.ConeGeometry(s[0], s[1], 20); break;
  }
  geometryCache.set(key, g);
  return g;
}

export interface InteractInfo {
  kind: 'inspect' | 'button' | 'door' | 'locked' | 'anomaly';
  action?: 'use' | 'stay';
  id: string;
  name: string;
  text?: string;
  /** Prompt wording for buttons, e.g. "Call the lift". */
  verb?: string;
}

/**
 * Builds one prop from its JSON recipe. Returns the group plus anything the
 * room must dispose later (text materials are unique per prop).
 */
export function buildProp(
  placed: PlacedProp,
  recipe: PropRecipe,
  materials: MaterialLibrary,
): { object: THREE.Group; owned: { dispose(): void }[] } {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const isWallMounted = recipe.fits.every((f) => f === 'wall_mounted');

  for (const part of recipe.parts) {
    const mesh = new THREE.Mesh(partGeometry(part), materials.get(part.mat));
    mesh.position.set(...part.pos);
    if (part.rot) mesh.rotation.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);
    mesh.castShadow = !isWallMounted;
    mesh.receiveShadow = true;
    // An invisible, larger target for small props: never drawn, but the aim ray still hits it.
    if (part.mat === 'hitbox') mesh.visible = false;
    if (part.anim) mesh.userData.anim = part.anim;
    group.add(mesh);
  }

  if (recipe.text && placed.surfaceText) {
    const mat = textMaterial(placed.surfaceText, recipe.text.style, recipe.text.size);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(...recipe.text.size), mat);
    plane.position.set(...recipe.text.pos);
    group.add(plane);
    group.userData.textPlane = plane;
    owned.push(mat.map!, mat, plane.geometry);
  }

  group.position.set(placed.x, placed.y, placed.z);
  group.rotation.y = placed.rotY;
  group.name = `${placed.id}:${recipe.id}`;

  if (recipe.inspectable || recipe.interact) {
    const info: InteractInfo = {
      kind: recipe.interact === 'button' ? 'button' : 'inspect',
      id: placed.id,
      name: recipe.name,
      text: placed.inspectText ?? placed.surfaceText,
      ...(recipe.verb ? { verb: recipe.verb } : {}),
    };
    group.userData.interact = info;
  }
  return { object: group, owned };
}
