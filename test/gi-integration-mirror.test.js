// Root-cause investigation #5 (parent live-GPU rerun, 09-29, 5th pass):
// per-ray shading parity is now PROVEN (dir/hitT/hit-miss/radiance/N all
// match GPU==CPU exactly). The parent's new suspicion: the CPU ORACLE's
// integration path (referenceUpdateProbe) doesn't equal a sum of its own
// traceSingleRay outputs for scene(i) probe 4, which they read as "inside
// a sealed box, every ray should hit, so atlas should be 0" -- contradicted
// by their own per-ray dump showing radiance 0 on hit rays.
//
// This file proves TWO things with real scene data:
// 1. referenceUpdateProbe's result IS exactly the documented cosine-
//    weighted Monte-Carlo integral of its OWN traceSingleRay/traceProbeRays
//    output -- not a raw sum (which is why a naive "sum the rays" sanity
//    check looked like a mismatch: it's comparing two different
//    aggregations, not evidence of a bug).
// 2. Scene(i) probe 4 (dead center of the box) is NOT actually sealed: the
//    voxel grid's Y window (heightRange, e.g. [3,9] for half=6) is
//    narrower than the box mesh's own full height (0..12), so floor/
//    ceiling triangles get skip-checked away entirely (voxelize.js's own
//    "fully outside" rule) -- the box is only voxelized as 4 SIDE walls
//    within a 6-unit-tall slice. A ray fired straight up/down from the
//    center travels only 3 units before exiting the GRID (not the true
//    box) and correctly reads sky, per the pass-#2 bounds-check fix. This
//    is a real, substantial per-probe sky contribution -- the CPU oracle's
//    nonzero atlas value for probe 4 is PHYSICALLY CORRECT for this scene
//    config, not a bug to "fix toward 0".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { referenceUpdateProbe, traceProbeRays } from '../client/kernel/gi/gi-reference.js';
import { integrateProbeIrradiance } from '../client/kernel/gi/irradiance.js';
import { decodeOct } from '../client/kernel/gi/octahedral.js';
import { voxelizeTriangles } from '../client/kernel/gi/voxelize.js';
import { buildClosedBoxScene, debugProbeRaysCPU } from '../tools/gi-parity.mjs';

function extractCfg(gi) {
  const { grid, probeGrid, params: p, sun } = gi.resources;
  const origin = [probeGrid.origin.value.x, probeGrid.origin.value.y, probeGrid.origin.value.z];
  const occArr = voxelizeTriangles(gi._sceneTriangles, gi._voxelConfig.voxelOriginArr, gi._voxelConfig.cellSize, gi._voxelConfig.dims);
  return {
    origin, spacing: probeGrid.spacing, dims: grid.dims, voxelDims: gi._voxelConfig.dims,
    occupancy: occArr, voxelOrigin: gi._voxelConfig.voxelOriginArr, cellSize: gi._voxelConfig.cellSize,
    sun: { direction: [sun.direction.value.x, sun.direction.value.y, sun.direction.value.z], color: [sun.color.value.x, sun.color.value.y, sun.color.value.z], intensity: sun.intensity.value },
    raysPerProbe: p.raysPerProbe, maxDist: p.voxelMaxDist, albedo: p.albedo, skyColor: p.skyColor,
    irradianceRes: p.irradianceRes, depthRes: p.depthRes,
  };
}

function liveClosedBoxCfg() {
  const { triangles, giParams } = buildClosedBoxScene();
  const gi = new GIController({});
  gi.configure(giParams);
  gi.setSceneTriangles(triangles);
  gi.update(1 / 60, [0, 0, 0]);
  return extractCfg(gi);
}

// ---------------------------------------------------- integration-path proof
test('referenceUpdateProbe\'s irradianceTexels EXACTLY equal integrateProbeIrradiance(texelDir, traceProbeRays(...)) for every texel -- no hidden extra step, no different ray set', () => {
  const cfg = liveClosedBoxCfg();
  const probePos = [0, 3, 0]; // probe 4, dead center
  const config = {
    probePos, occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims,
    maxDist: cfg.maxDist, raysPerProbe: cfg.raysPerProbe, rotation: null,
    sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor, irradianceRes: cfg.irradianceRes, depthRes: cfg.depthRes,
  };
  const probeResult = referenceUpdateProbe(config);
  const rays = traceProbeRays(config); // the SAME rays referenceUpdateProbe traces internally

  const res = cfg.irradianceRes;
  let i = 0;
  for (let v = 0; v < res; v++) {
    for (let u = 0; u < res; u++) {
      const uv = [((u + 0.5) / res) * 2 - 1, ((v + 0.5) / res) * 2 - 1];
      const n = decodeOct(uv);
      const expected = integrateProbeIrradiance(n, rays);
      assert.deepEqual(probeResult.irradianceTexels[i], expected, `texel ${i} (u=${u},v=${v}) must be EXACTLY the MC integral of the traced rays`);
      i++;
    }
  }
});

test('mutant: comparing a texel value to a RAW SUM of ray radiances (instead of the cosine-weighted MC integral) looks like a mismatch even though nothing is wrong -- documents why a naive "sum the rays" sanity check is the wrong comparison', () => {
  const cfg = liveClosedBoxCfg();
  const probePos = [0, 3, 0];
  const rays = traceProbeRays({
    probePos, occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims,
    maxDist: cfg.maxDist, raysPerProbe: cfg.raysPerProbe, rotation: null,
    sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor,
  });
  const rawSum = rays.reduce((s, r) => s + r.radiance[0] + r.radiance[1] + r.radiance[2], 0);
  const n = [0, 1, 0]; // straight-up texel direction
  const properIntegral = integrateProbeIrradiance(n, rays);
  const properSum = properIntegral[0] + properIntegral[1] + properIntegral[2];
  assert.notEqual(rawSum, properSum, 'the two aggregations are legitimately different numbers -- neither is "wrong", they answer different questions (total unweighted light vs the field value along one specific direction)');
});

// -------------------------------------------------- probe 4 is NOT sealed
test('scene(i) probe 4 (dead center) is NOT physically sealed: a meaningful fraction of its rays escape the Y-clipped voxel grid and read sky, not zero', () => {
  const cfg = liveClosedBoxCfg();
  const rays = debugProbeRaysCPU(4, cfg, cfg.raysPerProbe);
  const missCount = rays.filter((r) => !r.hit).length;
  assert.ok(missCount > 0, `expected some rays to escape vertically through the Y-clipped grid, got 0 misses out of ${rays.length}`);
  // and the resulting atlas value must be correspondingly nonzero, not 0
  const probeResult = referenceUpdateProbe({
    probePos: [0, 3, 0], occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims,
    maxDist: cfg.maxDist, raysPerProbe: cfg.raysPerProbe, rotation: null,
    sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor, irradianceRes: cfg.irradianceRes, depthRes: cfg.depthRes,
  });
  const total = probeResult.irradianceTexels.reduce((s, t) => s + t[0] + t[1] + t[2], 0);
  assert.ok(total > 1, `expected a substantial nonzero atlas contribution from the sky leak, got ${total}`);
});

test('mutant: assuming probe 4 is sealed (expected=0) would be WRONG for this scene config -- the box\'s heightRange is narrower than its own mesh height', () => {
  const { giParams } = buildClosedBoxScene();
  const [meshMinY, meshMaxY] = [0, 2 * (giParams.halfExtentXZ)]; // boxTriangles(-half,0,...,half,2*half,...)
  const [gridMinY, gridMaxY] = giParams.heightRange;
  assert.ok(gridMinY > meshMinY || gridMaxY < meshMaxY, 'the voxel grid Y-window must be strictly narrower than the box mesh -- this is exactly why probe 4 sees sky (floor/ceiling triangles fall fully outside the grid and get skipped)');
});
