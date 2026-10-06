// three-materials.js — the 3 Round-3 game TSL materials, built exactly as test/render-api-tsl.test.js builds them (sources from
// /tsl/ = scratch/tsl-games staged by that test). Shared by three-ref.html (three WebGPURenderer ground truth) and three.html (wasm).
// 'ee-sprite-op1' = gfx-sprite with opacity 1 (spawn sets 0, update() fades it in) — the only non-saturating probe of the set.
export const NAMES = ['boomtown-powerbox', 'bp-paintlerp', 'ee-sprite', 'ee-sprite-op1'];
export const CLEAR = [0.45, 0.55, 0.7]; // gaia-render RenderOptions::default clear_color (linear)
export const EYE = [1.5, 1.2, 2.5], FOV = 50, NEAR = 0.1, FAR = 100, SIZE = 256; // tests/three_material.rs camera
export async function buildMaterial(name, THREE) {
  const tex = () => { const t = new THREE.DataTexture(new Uint8Array(16).fill(200), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  if (name === 'boomtown-powerbox') {
    const src = await (await fetch('/tsl/boomtown-rampage-gwe/boomtown-powerbox-material.js')).text();
    const patched = src.replace(/import \{ registerMaterialShader \} from '[^']+';/, 'const registerMaterialShader = () => () => {};');
    const { buildPowerboxMaterial } = await import(URL.createObjectURL(new Blob([patched], { type: 'text/javascript' })));
    const tx = (u) => ({ url: u, scale: [1, 1], offset: [0, 0] });
    return buildPowerboxMaterial({ source: 'proof', background: tx('bg'), panning: tx('pan'), icon: tx('icon'), backgroundTint: [1, 1, 1, 1], edgeTint: [0.2, 0.4, 1, 1], iconTint: [1, 1, 1, 1], panColor: [0.5, 0.8, 1, 1],
      backgroundPower: 1, edgePower: 2, contrast: 1.2, iconContrast: 1.5, iconEmission: 2.5, panStrength: 1, panBStrength: 0.5, iconUvScale: 2, iconUvOffset: [0, -1], panAUvScale: 1, panASpeed: [0, 1.5], panBUvScale: 2, panBSpeed: [0, 2],
      metallic: 0, smoothness: 0.5, rotationAxis: [0, 1, 0], rotationSpeed: 1, bobSpeed: 2, bobHeight: 0.1 }, { loadTexture: tex });
  }
  if (name.startsWith('ee-sprite')) {
    const { createSpriteField } = await import('/tsl/empire-earth/gfx-sprites.js');
    const scene = new THREE.Scene();
    const field = createSpriteField({ scene, three: { ...THREE, TextureLoader: class { load(u, ok) { const x = tex(); queueMicrotask(() => ok?.()); return x; } } } });
    field.spawn({ textureUrl: 'smoke.png', position: [0, 1, 0], size: 2, durationMs: 1000 }, 0);
    const m = scene.children[0].children[0].material; if (name === 'ee-sprite-op1') m.opacity = 1; return m;
  }
  const { toPaintLerp } = await import('/tsl/burnout-paradise-gwe/bp-paintlerp.js');
  const src = new THREE.MeshStandardMaterial({ map: tex(), roughness: 0.4 }); src.userData.paint_lerp = true;
  return toPaintLerp(THREE, src);
}
export function makeScene(THREE, material) {
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const cam = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR); cam.position.set(...EYE); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  return { scene, cam };
}
