import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export async function createRenderer() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  return { renderer, scene, camera, hemi, sun, post };
}
