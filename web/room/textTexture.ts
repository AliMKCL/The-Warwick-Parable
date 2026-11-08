import * as THREE from 'three';
import type { TextStyle } from '../../core/room/types';

interface Style {
  bg: string;
  fg: string;
  font: string;
  weight: string;
  align: CanvasTextAlign;
  upper: boolean;
  pad: number;
  emissive: boolean;
}

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace';
const MARKER = '"Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive';

const POSTER_COLOURS = ['#2f5d62', '#b5523b', '#3d4f7a', '#6b5b3e', '#4c6b4a', '#7a3d4f'];

function styleFor(style: TextStyle, text: string): Style {
  switch (style) {
    case 'sign': return { bg: '#f7f6f1', fg: '#1d1f20', font: SANS, weight: '700', align: 'center', upper: true, pad: 0.08, emissive: false };
    case 'label': return { bg: '#fbfbf7', fg: '#222', font: SANS, weight: '600', align: 'center', upper: true, pad: 0.1, emissive: false };
    case 'poster': {
      const bg = POSTER_COLOURS[hash(text) % POSTER_COLOURS.length]!;
      return { bg, fg: '#f6f2e8', font: SANS, weight: '800', align: 'center', upper: false, pad: 0.12, emissive: false };
    }
    case 'screen': return { bg: '#0b1311', fg: '#a9f0c0', font: MONO, weight: '500', align: 'left', upper: false, pad: 0.08, emissive: true };
    case 'paper': return { bg: '#f5f2e8', fg: '#2c2c2a', font: MONO, weight: '500', align: 'left', upper: false, pad: 0.1, emissive: false };
    case 'whiteboard': return { bg: '#fbfbf9', fg: '#24438a', font: MARKER, weight: '500', align: 'left', upper: false, pad: 0.07, emissive: false };
    case 'led': return { bg: '#120904', fg: '#ffae42', font: MONO, weight: '700', align: 'center', upper: true, pad: 0.12, emissive: true };
    case 'sticky': return { bg: '#f4dd5c', fg: '#28323f', font: MARKER, weight: '600', align: 'center', upper: false, pad: 0.1, emissive: false };
  }
}

/** Draws text onto a canvas sized to the surface and returns a material for it. Font size is fitted to the space. */
export function textMaterial(text: string, style: TextStyle, size: [number, number]): THREE.MeshStandardMaterial {
  const s = styleFor(style, text);
  const pxPerM = style === 'label' ? 900 : 640;
  const w = Math.min(1024, Math.max(64, Math.round(size[0] * pxPerM)));
  const h = Math.min(1024, Math.max(32, Math.round(size[1] * pxPerM)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = s.bg;
  g.fillRect(0, 0, w, h);

  if (style === 'poster') {
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(w * 0.08, h * 0.82, w * 0.84, h * 0.012);
  }
  if (style === 'screen') {
    for (let y = 0; y < h; y += 4) {
      g.fillStyle = 'rgba(255,255,255,0.025)';
      g.fillRect(0, y, w, 1);
    }
  }

  const body = s.upper ? text.toUpperCase() : text;
  const padX = w * s.pad, padY = h * s.pad;
  const boxW = w - padX * 2, boxH = h - padY * 2;
  let fontPx = Math.min(boxH, 160);
  let lines: string[] = [];
  for (; fontPx > 8; fontPx -= 2) {
    g.font = `${s.weight} ${fontPx}px ${s.font}`;
    lines = wrap(g, body, boxW);
    if (lines.length * fontPx * 1.2 <= boxH && lines.every((l) => g.measureText(l).width <= boxW)) break;
  }
  g.fillStyle = s.fg;
  g.textBaseline = 'middle';
  g.textAlign = s.align;
  const lineH = fontPx * 1.2;
  const blockH = lines.length * lineH;
  const top = style === 'paper' || style === 'whiteboard' || style === 'screen' ? padY + lineH / 2 : h / 2 - blockH / 2 + lineH / 2;
  const x = s.align === 'center' ? w / 2 : padX;
  lines.forEach((line, i) => g.fillText(line, x, top + i * lineH));

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: tex,
    roughness: style === 'screen' ? 0.3 : 0.85,
    emissive: s.emissive ? '#ffffff' : '#000000',
    emissiveMap: s.emissive ? tex : null,
    emissiveIntensity: s.emissive ? 0.9 : 0,
  });
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0]!;
    for (const word of words.slice(1)) {
      const trial = `${line} ${word}`;
      if (g.measureText(trial).width <= maxW) line = trial;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
