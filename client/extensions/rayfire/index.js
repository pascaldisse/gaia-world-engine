// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Engine extension entry: register(ctx?) -> { name:'rayfire', api }. Published to games as window.gaia.rayfire by the
// extension loader. Pure api factory: ctx is ignored, no module state, so any number of register() calls is safe.
import { v3, meshVolume, facesVolume, isWatertight } from './geometry.js';
import { createRng, mixSeed, rand01 } from './prng.js';
import { RFX_NAMES } from './names.js';
import { closeOpenShell } from './closure.js';
import { fractureCells } from './fracture.js';
import { nextFragmentAmount, DEMOLITION_DEFAULTS, demolishMesh } from './demolition.js';
import { facesToBufferGeometry, geometryToTriangles, fracture, demolish } from './render.js';
import { RFWorld, RF_WORLD_DEFAULTS } from './world.js';
import { pointInBox, markUnyielding, buildAdjacency, assignJointStrength, breakJoints, connectedComponents, partitionByUnyielding, computeSupport, tickErosion } from './structure.js';
import { CollapseType, removeByArea, removeBySize, removeRandom, collapseStep, runCollapseSteps, COLLAPSE_DEFAULTS } from './collapse.js';
import { createActivationState, shouldActivate, activate } from './activation.js';
import { FadeType, createFadeState, tickFade, FADE_DEFAULTS } from './fade.js';
import { explode, shoot } from './impulses.js';

export {
  v3, meshVolume, facesVolume, isWatertight, createRng, mixSeed, rand01, RFX_NAMES, closeOpenShell, fractureCells,
  nextFragmentAmount, DEMOLITION_DEFAULTS, demolishMesh, facesToBufferGeometry, geometryToTriangles, fracture, demolish,
  RFWorld, RF_WORLD_DEFAULTS, pointInBox, markUnyielding, buildAdjacency, assignJointStrength, breakJoints, connectedComponents,
  partitionByUnyielding, computeSupport, tickErosion, CollapseType, removeByArea, removeBySize, removeRandom, collapseStep,
  runCollapseSteps, COLLAPSE_DEFAULTS, createActivationState, shouldActivate, activate, FadeType, createFadeState, tickFade,
  FADE_DEFAULTS, explode, shoot,
};

export const api = Object.freeze({
  v3, meshVolume, facesVolume, isWatertight, createRng, mixSeed, rand01, RFX_NAMES, closeOpenShell, fractureCells,
  nextFragmentAmount, DEMOLITION_DEFAULTS, demolishMesh, facesToBufferGeometry, geometryToTriangles, fracture, demolish,
  RFWorld, RF_WORLD_DEFAULTS, pointInBox, markUnyielding, buildAdjacency, assignJointStrength, breakJoints, connectedComponents,
  partitionByUnyielding, computeSupport, tickErosion, CollapseType, removeByArea, removeBySize, removeRandom, collapseStep,
  runCollapseSteps, COLLAPSE_DEFAULTS, createActivationState, shouldActivate, activate, FadeType, createFadeState, tickFade,
  FADE_DEFAULTS, explode, shoot,
});

export function register() {
  return { name: 'rayfire', api };
}
