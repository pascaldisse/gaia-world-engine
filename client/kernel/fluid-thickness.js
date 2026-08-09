// fluid-thickness.js — screen-space fluid P1/P2/P3 debug passes.
// Private targets only: no renderer.js/view.js seam and no allocation without fluid opt-in.

import * as THREE from 'three/webgpu';
import {
  instanceIndex, uv, float, vec2, vec3, vec4, sqrt, saturate, texture, screenUV,
  textureSize, positionLocal, modelViewMatrix, cameraProjectionMatrix,
  cameraProjectionMatrixInverse, cameraNear, cameraFar, viewZToPerspectiveDepth,
  getViewPosition, normalize, cross, abs, select, exp, pow, dot, clamp, sign,
} from 'three/tsl';

export const FLUID_THICKNESS_RENDER = {
  particleRadius: 0.075,
  smoothing: 1.35,
  thicknessScale: 1.0,
  targetScale: 1.0,
  blurRadius: 1.0,
  blurDepthSigma: 0.12,
  debugGain: 0.6,
  debugTint: [1, 1, 1],
  debugView: true,
  debugMode: 'thickness', // thickness | normal | composite
  debugBlend: 'replace',
  debugEpsilon: 1e-4,
  // composite (P4): screen-space refraction of the opaque scene through the
  // liquid, Beer–Lambert attenuated by accumulated thickness, Fresnel rim.
  refractionStrength: 0.08, // uv offset per metre of thickness
  fresnelF0: 0.02,
  fresnelTint: [1, 1, 1],
  attenuationColor: [0.18, 0.55, 1.0],
  attenuationDistance: 1.8,
};
const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;

/**
 * P1 writes positive linear view distance in a colour HalfFloat RT; its
 * hardware depth attachment receives the analytic near sphere surface. P2
 * reuses a depth attachment prefilled from opaque scene geometry, therefore
 * particles behind a wall fail the hardware depth test before additive chord
 * accumulation. P1/P2 share `impostorRadius`: it is the actual projected
 * analytic sphere radius, hence both its front depth and its chord describe
 * precisely the same volume.
 */
export function createFluidThickness({ renderer, camera, scene: mainScene, count, position, render = {} } = {}) {
  if (!renderer || !camera || !mainScene || !count || !position) throw new Error('[fluid-thickness] renderer, camera, scene, count and position required');
  const R = { ...FLUID_THICKNESS_RENDER, ...render };
  const radius = Math.max(1e-4, finite(R.particleRadius, FLUID_THICKNESS_RENDER.particleRadius));
  const smoothing = Math.max(0.1, finite(R.smoothing, FLUID_THICKNESS_RENDER.smoothing));
  const impostorRadius = radius * smoothing;
  const scale = Math.max(0, finite(R.thicknessScale, 1));
  const targetScale = Math.min(1, Math.max(0.1, finite(R.targetScale, 1)));
  const blurRadius = Math.max(0, finite(R.blurRadius, 1));
  const blurSigma = Math.max(1e-6, finite(R.blurDepthSigma, 0.12));
  const epsilon = Math.max(0, finite(R.debugEpsilon, 1e-4));
  const gain = Math.max(0, finite(R.debugGain, 0.6));
  const tint = Array.isArray(R.debugTint) && R.debugTint.length === 3 ? R.debugTint : [1, 1, 1];
  const targetOptions = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, stencilBuffer: false };
  // P1 needs a hardware depth attachment for nearest analytic sphere selection.
  const depthTarget = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: true });
  // P2 starts with opaque-scene depth, clears only colour, then additively draws.
  const thicknessTarget = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: true });
  const smoothTarget = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: false });
  depthTarget.texture.name = 'fluidViewZ'; thicknessTarget.texture.name = 'fluidThickness'; smoothTarget.texture.name = 'fluidViewZSmooth';
  const mode = R.debugMode === 'normal' || R.mode === 'normal' ? 'normal'
    : (R.debugMode === 'composite' || R.mode === 'composite' ? 'composite' : 'thickness');
  // P4 needs the opaque scene colour to refract through; allocated only in composite.
  const sceneTarget = mode === 'composite'
    ? new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: true })
    : null;
  if (sceneTarget) sceneTarget.texture.name = 'fluidSceneColour';

  const centerView = modelViewMatrix.mul(vec4(position.element(instanceIndex), 1));
  const offsetView = vec4(positionLocal.xy.mul(impostorRadius * 2), 0, 0);
  const clipPosition = cameraProjectionMatrix.mul(centerView.add(offsetView));
  const disc = uv().sub(0.5).mul(2).length();
  const inside = float(1).sub(disc.mul(disc)).max(0);
  const frontViewZ = centerView.z.add(sqrt(inside).mul(impostorRadius));

  const makeParticleMaterial = (kind) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.vertexNode = clipPosition;
    material.depthNode = viewZToPerspectiveDepth(frontViewZ, cameraNear, cameraFar);
    material.colorNode = kind === 'depth'
      ? vec3(frontViewZ.negate(), frontViewZ.negate(), frontViewZ.negate())
      : vec3(sqrt(inside).mul(2 * impostorRadius * scale));
    material.opacityNode = float(1);
    material.transparent = kind === 'thickness';
    material.blending = kind === 'thickness' ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.depthTest = true;
    material.depthWrite = kind === 'depth';
    material.fog = false;
    material.toneMapped = false;
    return material;
  };
  const geometry = new THREE.PlaneGeometry(1, 1);
  const depthMaterial = makeParticleMaterial('depth');
  const thicknessMaterial = makeParticleMaterial('thickness');
  const depthMesh = new THREE.InstancedMesh(geometry, depthMaterial, count);
  const thicknessMesh = new THREE.InstancedMesh(geometry, thicknessMaterial, count);
  depthMesh.frustumCulled = thicknessMesh.frustumCulled = false;
  const depthScene = new THREE.Scene(); depthScene.add(depthMesh);
  const thicknessScene = new THREE.Scene(); thicknessScene.add(thicknessMesh);

  // P3: one narrow-range bilateral step. Only neighbours within sigma contribute;
  // a zero/no-fluid sample never bleeds over the liquid silhouette.
  const blurMaterial = new THREE.MeshBasicNodeMaterial();
  blurMaterial.vertexNode = vec4(positionLocal.xy.mul(2), 0, 1);
  const rawDepth = texture(depthTarget.texture, screenUV).x;
  const texel = vec2(1).div(textureSize(texture(depthTarget.texture))).mul(blurRadius);
  const bilateral = (offset) => {
    const v = texture(depthTarget.texture, screenUV.add(offset)).x;
    return select(rawDepth.greaterThan(0).and(v.greaterThan(0)).and(abs(v.sub(rawDepth)).lessThan(blurSigma)), v, rawDepth);
  };
  const smoothDepth = rawDepth.add(bilateral(vec2(texel.x, 0))).add(bilateral(vec2(texel.x.negate(), 0)))
    .add(bilateral(vec2(0, texel.y))).add(bilateral(vec2(0, texel.y.negate()))).mul(0.2);
  blurMaterial.colorNode = vec3(smoothDepth);
  blurMaterial.toneMapped = false;
  const blurMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blurMaterial);
  const blurScene = new THREE.Scene(); blurScene.add(blurMesh);

  // Normal uses reconstructed neighbouring view positions from the smoothed
  // colour depth. It deliberately does not call getNormalFromDepth() on colour
  // RT and does not use raw dFdx/dFdy normals.
  const debugMaterial = new THREE.MeshBasicNodeMaterial();
  debugMaterial.vertexNode = vec4(positionLocal.xy.mul(2), 0, 1);
  const smoothed = texture(smoothTarget.texture, screenUV).x;
  const normalTexel = vec2(1).div(textureSize(texture(smoothTarget.texture)));
  const viewPos = (coord, distance) => getViewPosition(coord, viewZToPerspectiveDepth(distance.negate(), cameraNear, cameraFar), cameraProjectionMatrixInverse);
  const p = viewPos(screenUV, smoothed);
  const px = viewPos(screenUV.add(vec2(normalTexel.x, 0)), texture(smoothTarget.texture, screenUV.add(vec2(normalTexel.x, 0))).x);
  const py = viewPos(screenUV.add(vec2(0, normalTexel.y)), texture(smoothTarget.texture, screenUV.add(vec2(0, normalTexel.y))).x);
  const normal = normalize(cross(px.sub(p), py.sub(p)));
  const normalColour = normal.mul(0.5).add(0.5);
  const thicknessColour = vec3(...tint).mul(saturate(texture(thicknessTarget.texture, screenUV).x.mul(gain)));
  const isNormal = mode === 'normal';
  const thicknessM = texture(thicknessTarget.texture, screenUV).x;
  let compositeColour = null;
  if (mode === 'composite') {
    const strength = Math.max(0, finite(R.refractionStrength, 0.08));
    const f0 = Math.min(1, Math.max(0, finite(R.fresnelF0, 0.02)));
    const fTint = Array.isArray(R.fresnelTint) && R.fresnelTint.length === 3 ? R.fresnelTint : [1, 1, 1];
    const attC = Array.isArray(R.attenuationColor) && R.attenuationColor.length === 3 ? R.attenuationColor : [0.18, 0.55, 1.0];
    const attD = Math.max(1e-4, finite(R.attenuationDistance, 1.8));
    // Absorbance per metre per channel: what the attenuation colour does NOT pass.
    const absorb = vec3(...attC.map((c) => Math.max(0, 1 - c) / attD));
    const viewDir = normalize(p.negate());
    // Reconstruction winding may flip the normal; force it toward the viewer.
    const facingNormal = normal.mul(sign(dot(normal, viewDir)));
    const facing = saturate(dot(facingNormal, viewDir));
    const fresnel = pow(float(1).sub(facing), 5).mul(1 - f0).add(f0);
    const refractUV = clamp(screenUV.sub(facingNormal.xy.mul(saturate(thicknessM).mul(strength))), vec2(0), vec2(1));
    const refracted = texture(sceneTarget.texture, refractUV).rgb;
    const transmit = exp(absorb.mul(thicknessM).negate());
    compositeColour = refracted.mul(transmit).mul(float(1).sub(fresnel)).add(vec3(...fTint).mul(fresnel));
  }
  const sampledPresence = isNormal ? smoothed : thicknessM;
  debugMaterial.colorNode = mode === 'composite' ? compositeColour : (isNormal ? normalColour : thicknessColour);
  debugMaterial.opacityNode = R.debugBlend === 'add' ? float(1) : saturate(sampledPresence.sub(epsilon).mul(1 / Math.max(epsilon, 1e-6)));
  debugMaterial.transparent = true;
  debugMaterial.blending = R.debugBlend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending;
  debugMaterial.depthTest = false; debugMaterial.depthWrite = false; debugMaterial.fog = false; debugMaterial.toneMapped = false;
  const debugMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), debugMaterial);
  debugMesh.frustumCulled = false; debugMesh.renderOrder = 10000; debugMesh.visible = R.debugView !== false;

  const size = new THREE.Vector2();
  const resize = () => {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x * targetScale)), h = Math.max(1, Math.floor(size.y * targetScale));
    for (const target of [depthTarget, thicknessTarget, smoothTarget, ...(sceneTarget ? [sceneTarget] : [])]) if (target.width !== w || target.height !== h) target.setSize(w, h);
  };
  let rendering = false;
  const update = () => {
    if (rendering) return;
    rendering = true; resize();
    const state = THREE.RendererUtils.resetRendererAndSceneState(renderer, mainScene);
    const debugVisible = debugMesh.visible;
    try {
      // P1: clear both, retain nearest front sphere via analytic depthNode.
      renderer.setRenderTarget(depthTarget); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(depthScene, camera);
      // P2 occlusion: opaque main scene populates thicknessTarget.depth; only its
      // colour is cleared, preserving that attachment for depthTest=true particles.
      debugMesh.visible = false;
      renderer.setRenderTarget(thicknessTarget); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(mainScene, camera);
      renderer.clear(true, false, false); renderer.render(thicknessScene, camera);
      // P4: opaque scene colour, kept intact, for screen-space refraction.
      if (sceneTarget) { renderer.setRenderTarget(sceneTarget); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(mainScene, camera); }
      renderer.setRenderTarget(smoothTarget); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(blurScene, camera);
    } finally {
      debugMesh.visible = debugVisible;
      THREE.RendererUtils.restoreRendererAndSceneState(renderer, mainScene, state);
      rendering = false;
    }
  };
  const dispose = () => {
    geometry.dispose(); depthMaterial.dispose(); thicknessMaterial.dispose(); depthMesh.dispose?.(); thicknessMesh.dispose?.();
    blurMesh.geometry.dispose(); blurMaterial.dispose(); debugMesh.geometry.dispose(); debugMaterial.dispose();
    depthTarget.dispose(); thicknessTarget.dispose(); smoothTarget.dispose(); sceneTarget?.dispose();
  };
  return { mesh: debugMesh, depthTarget, thicknessTarget, smoothTarget, sceneTarget, update, dispose, params: { ...R, impostorRadius, mode } };
}
export default createFluidThickness;
