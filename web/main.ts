import * as THREE from 'three';
import './styles.css';
import { createLlmClient } from '../core/llm/client';
import { Loop } from './render/loop';
import { createRenderer, resizeRenderer } from './render/renderer';

/**
 * Phase 1 setup check: proves rendering and the model connection work on this
 * machine. Replaced by the real game entry in Phase 2.
 */
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
if (!canvas) throw new Error('Missing #game-canvas');

const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe3e2);
scene.fog = new THREE.Fog(0xdfe3e2, 6, 22);
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 60);

// A sterile waiting room: 8 x 3 x 8 m box seen from the inside.
const wall = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.92 });
const floor = new THREE.MeshStandardMaterial({ color: 0xb9bbb6, roughness: 0.8 });
const room = new THREE.Group();
const shell = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 8), wall);
shell.material.side = THREE.BackSide;
shell.position.y = 1.5;
shell.receiveShadow = true;
room.add(shell);
const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floor);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.position.y = 0.001;
floorMesh.receiveShadow = true;
room.add(floorMesh);

// Ceiling light panels: emissive quads plus the light they "cast".
const panelMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 1.6 });
for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) {
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), panelMat);
  panel.rotation.x = Math.PI / 2;
  panel.position.set(x, 2.99, z);
  room.add(panel);
}

// The pedestal and the button the player will be asked to press.
const pedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(0.22, 0.28, 1.0, 32),
  new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.6 }),
);
pedestal.position.y = 0.5;
pedestal.castShadow = true;
room.add(pedestal);
const button = new THREE.Mesh(
  new THREE.CylinderGeometry(0.09, 0.1, 0.06, 32),
  new THREE.MeshStandardMaterial({ color: 0xc42a22, roughness: 0.35, emissive: 0x3a0503 }),
);
button.position.y = 1.03;
button.castShadow = true;
room.add(button);
scene.add(room);

scene.add(new THREE.HemisphereLight(0xf6f8ff, 0x8b8c88, 1.1));
const key = new THREE.PointLight(0xf4f8ff, 18, 14, 2);
key.position.set(0.6, 2.7, 0.4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);

const loop = new Loop(
  (_dt, t) => {
    resizeRenderer(renderer, camera);
    const a = t * 0.12;
    camera.position.set(Math.sin(a) * 3.2, 1.6, Math.cos(a) * 3.2);
    camera.lookAt(0, 0.95, 0);
  },
  () => renderer.render(scene, camera),
);
loop.start();

const rendererStatus = document.querySelector('#status-renderer');
if (rendererStatus) {
  const gl = renderer.getContext();
  rendererStatus.textContent = gl instanceof WebGL2RenderingContext ? 'WebGL2 ok' : 'WebGL ok';
  rendererStatus.className = 'ok';
}

// Model server check through the Vite proxy (/llm -> LLM_BASE_URL in .env.local).
const llm = createLlmClient(
  { provider: __LLM_PROVIDER__, baseUrl: '/llm', model: __LLM_MODEL__ },
  { fetch: (url, init) => fetch(url, init), now: () => performance.now() },
);
const llmStatus = document.querySelector('#status-llm');
llm.ping().then((r) => {
  if (!llmStatus) return;
  if (!r.ok) {
    llmStatus.textContent = 'not reachable';
    llmStatus.className = 'bad';
  } else if (!r.hasModel) {
    llmStatus.textContent = `up, but ${__LLM_MODEL__} missing`;
    llmStatus.className = 'bad';
  } else {
    llmStatus.textContent = `${__LLM_MODEL__} ready`;
    llmStatus.className = 'ok';
  }
});

// Lets automated checks confirm the scene is drawing.
// Test hook: renders one frame and samples it straight away (WebGL clears the
// buffer after presenting, so reading it later gives a blank image).
function sampleFrame(): { mean: number; sd: number } {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(4);
  const lum: number[] = [];
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 32; x++) {
      gl.readPixels(Math.floor(((x + 0.5) / 32) * w), Math.floor(((y + 0.5) / 18) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      lum.push(0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!);
    }
  }
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const sd = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
  return { mean, sd };
}
(window as unknown as { __WHACK__: unknown }).__WHACK__ = { phase: 1, renderer: renderer.info, sampleFrame };
