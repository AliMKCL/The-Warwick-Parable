import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Vignette, film grain and a faint colour fringe at the edges: the "slightly wrong" finish. */
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, vignette: { value: 0.32 }, grain: { value: 0.022 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float time; uniform float vignette; uniform float grain;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * 0.006;
      vec4 c = texture2D(tDiffuse, vUv);
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.b = texture2D(tDiffuse, vUv - off).b;
      c.rgb *= 1.0 - vignette * smoothstep(0.08, 0.55, r2 * 1.6);
      c.rgb += (rand(vUv * 1000.0 + time) - 0.5) * grain;
      gl_FragColor = c;
    }`,
};

export interface Post {
  composer: EffectComposer;
  setScene(scene: THREE.Scene): void;
  setSize(w: number, h: number, dpr: number): void;
  render(t: number): void;
}

/** Render pipeline: scene → ambient occlusion → bloom on the light panels → finish → tone mapping. */
export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Post {
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
  ao.blendIntensity = 0.85;
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.3, 1.5);
  const finish = new ShaderPass(FinishShader);
  composer.addPass(renderPass);
  composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(finish);
  composer.addPass(new OutputPass());
  return {
    composer,
    setScene(s) {
      renderPass.scene = s;
      ao.scene = s;
    },
    setSize(w, h, dpr) {
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
    },
    render(t) {
      finish.uniforms.time!.value = t % 100;
      composer.render();
    },
  };
}
