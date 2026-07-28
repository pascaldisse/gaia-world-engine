import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// §IRON ADAPTIVE PIXEL RATIO. A procedural sky is fragment-bound: the nebula
// quads can each cover the whole frame, so the SAME shot ran 12.9 fps at
// devicePixelRatio 2 and ~50 at 1 (measured, proof/beauty/universe/probe
// s4-d42 vs a1-d42). Resolution is the one budget a viewer forgives losing.
//
// Law: never oscillate. The ratio steps DOWN only when a 30-frame rolling mean
// sits under `down` fps, steps back UP only above `up` fps (a wide hysteresis
// band), and never more than one step per `holdMs` — a 55/65 band with no hold
// visibly pumped between 1.0 and 2.0 twice a second.
export const PIXEL_IRON = {
  adaptivePixelRatio: true,
  max: 2,        // the cap that was hard-coded before this table existed
  min: 1,        // 1.0 is still crisp on a Retina panel; below it text mushes
  down: 52,      // step down under this (a 60 fps target with headroom for a hitch)
  up: 74,        // step up only above this — 62 here pumped, 74 never did
  step: 0.5,     // 2 → 1.5 → 1.0: three rungs, no cliff
  window: 30,    // frames in the rolling mean
  holdMs: 1200,  // minimum dwell between changes
};

export function createPixelGovernor(renderer, options = {}) {
  const O = { ...PIXEL_IRON, ...options };
  const cap = Math.min(O.max, typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  let ratio = cap;
  let acc = 0;
  let n = 0;
  let last = -Infinity;
  renderer.setPixelRatio(ratio);
  return {
    get ratio() { return ratio; },
    set enabled(v) { O.adaptivePixelRatio = !!v; },
    /** call once per frame with the frame's dt in seconds */
    sample(dt, now = performance.now()) {
      if (!O.adaptivePixelRatio || !(dt > 0)) return ratio;
      acc += dt; n += 1;
      if (n < O.window) return ratio;
      const fps = n / acc;
      acc = 0; n = 0;
      if (now - last < O.holdMs) return ratio;
      let next = ratio;
      if (fps < O.down) next = Math.max(O.min, ratio - O.step);
      else if (fps > O.up) next = Math.min(cap, ratio + O.step);
      if (next !== ratio) {
        ratio = next;
        last = now;
        renderer.setPixelRatio(ratio);
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
      return ratio;
    },
  };
}

export async function createRenderer() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  // pixel ratio is owned by the governor below (§IRON PIXEL_IRON)
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101c30');
  scene.fog = new THREE.Fog('#101c30', 60, 280);

  // far 4000: the world axis runs ~2.5km — backdrop silhouettes (the tree,
  // the void glow) must survive the projection, not just the fog
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 4000);

  // environment lighting is kernel-owned in v0; moves into world data later
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
  sun.position.set(60, 90, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.camera.far = 400;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // bloom post chain (TSL) — falls back to a plain render if unavailable
  let post = null;
  try {
    const postProcessing = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const bloomPass = bloom(color, 0.35, 0.4, 0.85);
    postProcessing.outputNode = color.add(bloomPass);
    post = {
      render: () => postProcessing.render(),
      setBloom: ({ strength, radius, threshold } = {}) => {
        if (strength !== undefined) bloomPass.strength.value = strength;
        if (radius !== undefined) bloomPass.radius.value = radius;
        if (threshold !== undefined) bloomPass.threshold.value = threshold;
      },
    };
  } catch (err) {
    console.warn('[gaia] post chain unavailable, rendering plain:', err);
  }

  const pixels = createPixelGovernor(renderer);
  return { renderer, scene, camera, hemi, sun, post, pixels };
}
