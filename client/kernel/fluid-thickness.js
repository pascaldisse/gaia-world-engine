// fluid-thickness.js — P2 of the screen-space fluid skin: the THICKNESS pass.
//
// 8e28cd9 regressed for TWO independent reasons (audit-kali 0b09391,
// design-vishnu 20a1da5):
//   1. `material.positionNode = storagePosition` — NodeMaterial's setupPosition
//      ASSIGNS positionLocal, so every sphere vertex collapsed onto the particle
//      centre: zero area, zero pixels. The cure is ADDITION, never replacement.
//   2. no thickness/composite pass existed, so even a repaired surface had
//      nothing to refract through.
//
// This file is the second half's first pass, on its own, so it can be SEEN:
// particles are ANALYTIC quad billboards (2 triangles, not a 96-triangle
// sphere) accumulated additively into a PRIVATE half-float render target.
// Chord of a sphere of radius r at normalised offset d from its centre:
//     chord(d) = 2 * r * sqrt(1 - d²)        (d = |uv-0.5|*2, d > 1 → 0)
// summed along the view ray, that IS optical thickness in metres.
//
// Ownership rules obeyed here (both ledgers):
// - renderer.js / view.js / the post chain are NOT touched. The private target
//   is rendered by this module and its debug view is an ordinary scene mesh,
//   so it joins main `pass(scene,camera)` naturally.
// - renderer + scene state are saved and restored around the private pass.
// - everything lives behind the world-data fluid gate, so a world that never
//   opts in allocates nothing (Atlas stays bit-identical).

import * as THREE from 'three/webgpu';
import {
  instanceIndex, uv, float, vec3, vec4, sqrt, saturate, texture, screenUV,
  positionLocal, modelViewMatrix, cameraProjectionMatrix,
} from 'three/tsl';

export const FLUID_THICKNESS_RENDER = {
  particleRadius: 0.075,   // metres, sphere radius of one particle
  smoothing: 1.35,         // impostor radius = particleRadius * smoothing
  thicknessScale: 1.0,     // multiplies the accumulated chord (optical depth)
  targetScale: 1.0,        // private RT resolution vs drawing buffer
  // Debug view only: metres of accumulated thickness that map to white.
  // It NEVER feeds physics — a bright plate is not evidence of thick liquid.
  debugGain: 0.6,
  debugTint: [1.0, 1.0, 1.0], // grey by default; a tint helps read overlaps
  debugView: true,            // draw the grey map; false = accumulate only
  // 'replace' paints the grey map over the scene where liquid is (the map is
  // READABLE: a lit scene plus additive grey saturates to white and proves
  // nothing). 'add' keeps the old additive glow for context shots.
  debugBlend: 'replace',
  debugEpsilon: 1e-4,         // metres of thickness that count as "liquid here"
};

const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/**
 * Build the additive thickness pass from GPU particle state.
 * Pure: it owns a private scene, a private render target, two materials and a
 * debug mesh. No CPU readback, no globals, no engine seams.
 *
 * @param {object} o
 * @param {THREE.Renderer} o.renderer  the engine's WebGPURenderer
 * @param {THREE.Camera} o.camera      the camera the main pass uses
 * @param {number} o.count             particle count
 * @param {object} o.position          storage buffer node (vec3 positions)
 * @param {object} [o.render]          overrides for FLUID_THICKNESS_RENDER
 */
export function createFluidThickness({ renderer, camera, count, position, render = {} } = {}) {
  if (!count || !position) throw new Error('[fluid-thickness] count and position required');
  const R = { ...FLUID_THICKNESS_RENDER, ...render };
  const radius = Math.max(1e-4, finite(R.particleRadius, FLUID_THICKNESS_RENDER.particleRadius));
  const smoothing = Math.max(0.1, finite(R.smoothing, FLUID_THICKNESS_RENDER.smoothing));
  const scale = Math.max(0, finite(R.thicknessScale, FLUID_THICKNESS_RENDER.thicknessScale));
  const gain = Math.max(0, finite(R.debugGain, FLUID_THICKNESS_RENDER.debugGain));
  const targetScale = Math.min(1, Math.max(0.1, finite(R.targetScale, 1)));
  const tint = Array.isArray(R.debugTint) && R.debugTint.length === 3
    ? R.debugTint : FLUID_THICKNESS_RENDER.debugTint;
  const impostorRadius = radius * smoothing;

  // ── private target ─────────────────────────────────────────────────────────
  // Half-float: thickness is metres summed over overlaps, so it leaves [0,1].
  // A colour target, never a hardware depth texture — sampling a depth texture
  // with a filtering sampler fails WGSL validation (audit-kali).
  const target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,      // the pass is a SUM; nothing may occlude anything
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'fluidThickness';

  // ── impostor cloud (private scene) ─────────────────────────────────────────
  const material = new THREE.MeshBasicNodeMaterial();
  // ANALYTIC BILLBOARD. positionLocal is ADDED in VIEW space — the quad keeps
  // its area (the collapse of 8e28cd9 was an assign), and facing the camera is
  // free because the offset is applied after the view transform.
  const centerView = modelViewMatrix.mul(vec4(position.element(instanceIndex), 1.0));
  const offsetView = vec4(positionLocal.xy.mul(impostorRadius * 2.0), 0.0, 0.0);
  material.vertexNode = cameraProjectionMatrix.mul(centerView.add(offsetView));

  const d = uv().sub(0.5).mul(2.0).length();
  const inside = float(1.0).sub(d.mul(d)).max(0.0);          // 1 - d², clamped
  const chord = sqrt(inside).mul(2.0 * impostorRadius * scale);
  // Additive blending already multiplies by srcAlpha, so alpha stays 1 and the
  // physical quantity lives in the colour — doing both would square the
  // fall-off (the mistake presets.js:327 documents).
  material.colorNode = vec3(chord, chord, chord);
  material.opacityNode = float(1.0);
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.name = 'gaia-fluid-thickness-impostors';

  const scene = new THREE.Scene();
  scene.name = 'gaia-fluid-thickness-scene';
  scene.add(mesh);

  // ── debug view (ordinary scene mesh, joins the main pass) ──────────────────
  // A clip-space quad: `vertexNode` puts it on the near plane directly, so no
  // camera, no transform, and no seam in renderer.js/view.js is needed.
  const debugMaterial = new THREE.MeshBasicNodeMaterial();
  debugMaterial.vertexNode = vec4(positionLocal.xy.mul(2.0), 0.0, 1.0);
  const sampled = texture(target.texture, screenUV).x;
  const additive = R.debugBlend === 'add';
  const epsilon = Math.max(0, finite(R.debugEpsilon, FLUID_THICKNESS_RENDER.debugEpsilon));
  debugMaterial.colorNode = vec3(...tint).mul(saturate(sampled.mul(gain)));
  // In 'replace' the alpha is PRESENCE (is there liquid on this ray at all),
  // never the thickness itself — thickness must stay in the colour or the
  // plate reads brightness twice and the grey ramp becomes a lie.
  debugMaterial.opacityNode = additive
    ? float(1.0)
    : saturate(sampled.sub(epsilon).mul(1.0 / Math.max(epsilon, 1e-6)));
  debugMaterial.transparent = true;
  debugMaterial.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  debugMaterial.depthTest = false;
  debugMaterial.depthWrite = false;
  debugMaterial.fog = false;
  debugMaterial.toneMapped = false;

  const debugMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), debugMaterial);
  debugMesh.frustumCulled = false;
  debugMesh.renderOrder = 10000;
  debugMesh.visible = R.debugView !== false;
  debugMesh.name = 'gaia-fluid-thickness';

  // ── the pass ───────────────────────────────────────────────────────────────
  const size = new THREE.Vector2();
  const resize = () => {
    if (!renderer?.getDrawingBufferSize) return;
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x * targetScale));
    const h = Math.max(1, Math.floor(size.y * targetScale));
    if (target.width !== w || target.height !== h) target.setSize(w, h);
  };

  let rendering = false;
  /** Accumulate thickness into the private target. Call before the main pass. */
  const update = (activeCamera = camera) => {
    if (!renderer || !activeCamera || rendering) return;
    resize();
    rendering = true;
    // The renderer's target/clear state belongs to the engine, not to us.
    const state = THREE.RendererUtils.resetRendererAndSceneState(renderer, scene);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, activeCamera);
    } finally {
      THREE.RendererUtils.restoreRendererAndSceneState(renderer, scene, state);
      rendering = false;
    }
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
    debugMesh.geometry.dispose();
    debugMaterial.dispose();
    target.dispose();
    scene.remove(mesh);
  };

  return {
    mesh: debugMesh,     // what the world's scene shows
    impostors: mesh,     // what the private pass draws
    scene, target, update, dispose,
    params: { ...R, impostorRadius },
  };
}

export default createFluidThickness;
