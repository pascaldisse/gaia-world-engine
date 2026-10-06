// three-r4.js — r4 proof cases (live uniforms + lights), shared by three-ref-r4.html (three r180 WebGPU ground truth) and the
// node dumper .scratch/r4/dump.mjs (→ native tests/three_uniforms.rs). `env.material(name)` = three-materials.js-style builder.
// sprite: ONE material, opacity per frame 0 / 0.5 / 1 (as gfx-sprites update() fades). lit: sun + 1 point light.
export const CASES = [
  { name: 'ee-sprite', base: 'ee-sprite', frames: [{ opacity: 0 }, { opacity: 0.5 }, { opacity: 1 }], lit: false },
  { name: 'bp-paintlerp-lit', base: 'bp-paintlerp', frames: [{}], lit: true },
  { name: 'boomtown-powerbox-lit', base: 'boomtown-powerbox', frames: [{}], lit: true },
];
export function addLights(THREE, scene) {
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 5, 2); scene.add(sun, sun.target);
  const pt = new THREE.PointLight(0xff8040, 6, 10, 2); pt.position.set(1.2, 1.4, 1.6); scene.add(pt);
  scene.updateMatrixWorld(true);
}
export const applyFrame = (material, f) => { if (f.opacity != null) material.opacity = f.opacity; };
