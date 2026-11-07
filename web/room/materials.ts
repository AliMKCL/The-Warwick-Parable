import * as THREE from 'three';
import type { AmbiencePreset, MaterialDef } from '../../core/room/types';

/** Shared materials built from data/materials.json, created once and reused by every room. */
export class MaterialLibrary {
  private cache = new Map<string, THREE.MeshStandardMaterial>();

  constructor(private defs: Record<string, MaterialDef>) {}

  get(name: string): THREE.MeshStandardMaterial {
    let m = this.cache.get(name);
    if (m) return m;
    const def = this.defs[name] ?? { color: '#ff00ff' };
    m = new THREE.MeshStandardMaterial({
      color: def.color,
      roughness: def.roughness ?? 0.7,
      metalness: def.metalness ?? 0,
      emissive: def.emissive ?? '#000000',
      emissiveIntensity: def.emissiveIntensity ?? 1,
      transparent: def.opacity !== undefined,
      opacity: def.opacity ?? 1,
    });
    m.name = name;
    this.cache.set(name, m);
    return m;
  }
}

/** Per-room surface materials, tinted by the ambience preset. Disposed with the room. */
export function surfaceMaterials(a: AmbiencePreset) {
  return {
    wall: new THREE.MeshStandardMaterial({ color: a.wall, roughness: 0.94, map: wallTexture() }),
    floor: new THREE.MeshStandardMaterial({ color: a.floor, roughness: 0.92, map: carpetTexture() }),
    ceiling: new THREE.MeshStandardMaterial({ color: a.ceiling, roughness: 0.96, map: ceilingTexture() }),
    trim: new THREE.MeshStandardMaterial({ color: '#5b5d5a', roughness: 0.7 }),
    panel: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: a.light, emissiveIntensity: 2.4 }),
    void: new THREE.MeshBasicMaterial({ color: '#050505' }),
  };
}

let carpet: THREE.Texture | undefined;
function carpetTexture(): THREE.Texture {
  if (carpet) return carpet;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  // Subtle carpet-tile grain plus tile seams every 128 px (= 0.5 m).
  const img = g.getImageData(0, 0, 256, 256);
  let seed = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = 228 + ((seed % 1000) / 1000) * 27;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.lineWidth = 2;
  for (const p of [0, 128]) {
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
  }
  carpet = new THREE.CanvasTexture(c);
  carpet.wrapS = carpet.wrapT = THREE.RepeatWrapping;
  carpet.colorSpace = THREE.SRGBColorSpace;
  carpet.anisotropy = 4;
  return carpet;
}

let wallTex: THREE.Texture | undefined;
/** Faint painted-plaster mottling so walls don't read as flat colour. One tile per metre. */
function wallTexture(): THREE.Texture {
  if (wallTex) return wallTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const r = 10 + rand() * 30;
    g.fillStyle = `rgba(0,0,0,${0.0025 + rand() * 0.004})`;
    // Draw each blob wrapped around the edges so tiles join without seams.
    const x = rand() * 256, y = rand() * 256;
    for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  wallTex = new THREE.CanvasTexture(c);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  wallTex.colorSpace = THREE.SRGBColorSpace;
  return wallTex;
}

let ceiling: THREE.Texture | undefined;
function ceilingTexture(): THREE.Texture {
  if (ceiling) return ceiling;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  // Drop-ceiling grid: one tile per 0.5 m.
  g.strokeStyle = 'rgba(0,0,0,0.16)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 128, 128);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = 'rgba(0,0,0,0.05)';
    g.fillRect((i * 37) % 128, (i * 53) % 128, 2, 2);
  }
  ceiling = new THREE.CanvasTexture(c);
  ceiling.wrapS = ceiling.wrapT = THREE.RepeatWrapping;
  ceiling.colorSpace = THREE.SRGBColorSpace;
  return ceiling;
}
