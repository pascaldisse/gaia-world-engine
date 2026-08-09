// fluid-surface.js — opt-in depth-writing fluid surface renderer.
//
// The simulation's storage position buffer is rendered as overlapping sphere
// impostors. Unlike the legacy alpha sprites, these fragments write their
// sphere depth, so normal, Fresnel reflection/refraction, and Beer–Lambert
// attenuation are evaluated by the native physical material per visible
// surface. `smoothing` controls the overlap that closes particle gaps; it is a
// data parameter, never a scene-specific constant.

import * as THREE from 'three/webgpu';
import { instanceIndex } from 'three/tsl';

export const FLUID_SURFACE_RENDER = {
  particleRadius: 0.075,
  smoothing: 1.35,
  roughness: 0.075,
  metalness: 0.0,
  transmission: 0.92,
  thickness: 0.42,
  ior: 1.333,
  attenuationColor: [0.18, 0.55, 1.0],
  attenuationDistance: 1.8,
  clearcoat: 0.5,
  clearcoatRoughness: 0.06,
};

const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;

/**
 * Create a depth-writing, refractive representation from GPU particle state.
 * It deliberately has no CPU readback and owns only its geometry/material.
 */
export function createFluidSurface({ count, position, render = {} } = {}) {
  if (!count || !position) throw new Error('[fluid-surface] count and position required');
  const R = { ...FLUID_SURFACE_RENDER, ...render };
  const radius = Math.max(1e-4, finite(R.particleRadius, FLUID_SURFACE_RENDER.particleRadius));
  const smoothing = Math.max(0.1, finite(R.smoothing, FLUID_SURFACE_RENDER.smoothing));
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: Math.max(0, finite(R.roughness, FLUID_SURFACE_RENDER.roughness)),
    metalness: Math.max(0, finite(R.metalness, FLUID_SURFACE_RENDER.metalness)),
    transmission: Math.min(1, Math.max(0, finite(R.transmission, FLUID_SURFACE_RENDER.transmission))),
    thickness: Math.max(0, finite(R.thickness, FLUID_SURFACE_RENDER.thickness)),
    ior: Math.max(1, finite(R.ior, FLUID_SURFACE_RENDER.ior)),
    attenuationDistance: Math.max(1e-4, finite(R.attenuationDistance, FLUID_SURFACE_RENDER.attenuationDistance)),
    clearcoat: Math.min(1, Math.max(0, finite(R.clearcoat, FLUID_SURFACE_RENDER.clearcoat))),
    clearcoatRoughness: Math.max(0, finite(R.clearcoatRoughness, FLUID_SURFACE_RENDER.clearcoatRoughness)),
  });
  material.color.setRGB(...(R.color || [0.32, 0.62, 1.0]));
  material.attenuationColor.setRGB(...R.attenuationColor);
  // This node reads the same compute-owned storage buffer used by simulation.
  material.positionNode = position.element(instanceIndex);
  material.depthWrite = true;
  material.transparent = false;

  // 12 segments retain a round depth silhouette without the extreme vertex
  // cost of a high-poly mesh at 16k instances.
  const geometry = new THREE.SphereGeometry(radius * smoothing, 12, 8);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.name = 'gaia-fluid-surface';
  return { mesh, params: R };
}

export default createFluidSurface;
