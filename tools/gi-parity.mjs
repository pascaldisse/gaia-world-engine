// GPU <-> CPU-reference parity harness for probe GI (§GI-PROBES.md, parent
// review stage F). Two halves:
//   - PURE, node-testable: compareAtlas(), computeUpdateCount(), the scene
//     triangle builders (buildClosedBoxScene / buildOpenPlaneRedWallScene).
//     `import * as THREE from 'three/webgpu'` resolves fine under plain
//     Node (this package's node_modules exports it, proven throughout this
//     repo's own node --test suite) but nothing in this module CONSTRUCTS
//     a renderer at import time — `new THREE.WebGPURenderer()` needs a
//     browser `document` (confirmed: throws "document is not defined"
//     under plain node), so that only ever happens inside
//     runScene()/runAll(), which only tools/gi-parity.html actually calls,
//     in a real browser with a WebGPU device.
//   - BROWSER-only orchestration: runScene()/runAll() build a real
//     WebGPURenderer, drive a real GIController for K updates, read the
//     GPU atlas back via renderer.getArrayBufferAsync(), and compare it to
//     gi-reference.js run on the identical inputs (same occupancy, same
//     probe positions, same sun, same unrotated ray set).
//
// See tools/gi-parity.html for exact serve + open instructions.

import * as THREE from 'three/webgpu';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { referenceUpdateProbe } from '../client/kernel/gi/gi-reference.js';
import { voxelizeTriangles } from '../client/kernel/gi/voxelize.js';
import { probeIndex } from '../client/kernel/gi/probe-grid.js';

// ---------------------------------------------------------------- tolerance
// Documented tolerance (§GI-PROBES.md UNVERIFIED — needs a real GPU frame to
// confirm/tighten): the GPU atlas storage is float32 (~1e-6 relative
// rounding, negligible next to the second term below). The dominant
// expected error source is the fixed-step DDA march (voxelize.js's
// marchOccupancy and gi-nodes.js's marchOccupancyTSL both step at
// cellSize*0.5): a ray whose true surface crossing sits within one step of
// a voxel boundary can register its hit on a different side if CPU
// (float64 JS) vs GPU (float32 WGSL) arithmetic round a t-value across that
// boundary. Both scenes below are built with geometry deliberately not
// flush against a march-step boundary, so this should be rare; the
// tolerance still has to absorb it when it happens — a starting point, not
// a final calibration (Pascal: tighten/loosen after seeing real numbers).
export const DEFAULT_TOLERANCE = { absTol: 5e-3, relTol: 0.05 };

/**
 * Compare a GPU-read-back atlas (Float32Array/array-like) to the CPU
 * reference's flattened atlas of the SAME layout (probeIndex*texelsPerProbe
 * *3 + texel*3 + channel). Pure, GPU-free — exercised on synthetic arrays
 * by the node-side test (test/gi-parity.test.js).
 */
export function compareAtlas(actual, expected, tolerance = DEFAULT_TOLERANCE) {
  if (actual.length !== expected.length) {
    return { pass: false, maxAbsErr: Infinity, meanAbsErr: Infinity, count: 0, firstFailIndex: -1, reason: `length mismatch: ${actual.length} vs ${expected.length}` };
  }
  const { absTol, relTol } = tolerance;
  let maxAbsErr = 0;
  let sum = 0;
  let firstFailIndex = -1;
  for (let i = 0; i < actual.length; i++) {
    const err = Math.abs(actual[i] - expected[i]);
    sum += err;
    if (err > maxAbsErr) maxAbsErr = err;
    const tol = absTol + relTol * Math.abs(expected[i]);
    if (err > tol && firstFailIndex === -1) firstFailIndex = i;
  }
  return { pass: firstFailIndex === -1, maxAbsErr, meanAbsErr: sum / actual.length, count: actual.length, firstFailIndex };
}

/**
 * How many update() calls are needed for (a) the round-robin probeOffset to
 * cycle through every probe at least once and (b) each probe's hysteresis
 * blend to have converged within `convergenceTolerance` of its steady-state
 * value — GIVEN that this harness's scenes use a static, UNROTATED ray set
 * (rotation=null everywhere: gi-controller.js does not wire a per-frame ray
 * rotation yet, see docs UNVERIFIED), so a probe's "new estimate" is
 * bit-identical every time it is touched: mix(new, old, alpha) after n
 * touches = new*(1-alpha^n) + old_0*alpha^n, so n with alpha^n <=
 * convergenceTolerance is sufficient. Pure, node-testable.
 */
export function computeUpdateCount({ updateFraction, alpha, convergenceTolerance = 1e-3 }) {
  const cyclesForFullCoverage = Math.ceil(1 / updateFraction);
  const itersForConvergence = Math.max(1, Math.ceil(Math.log(convergenceTolerance) / Math.log(alpha)));
  return cyclesForFullCoverage * itersForConvergence;
}

// ------------------------------------------------------------- scene builders
// Both build REAL triangles (authored mesh data) fed through
// setSceneTriangles() exactly as a live scene would — not raw occupancy
// arrays — so the harness exercises the actual CPU voxelize.js pipeline
// end to end, the same code path the GPU controller runs internally.
// Pure, node-testable (no THREE construction, just arrays of numbers).

function boxTriangles(minX, minY, minZ, maxX, maxY, maxZ) {
  // 6 faces x 2 triangles; winding is irrelevant — voxelize.js only uses
  // each triangle's AABB, never its normal
  const a = [minX, minY, minZ], b = [maxX, minY, minZ], c = [maxX, maxY, minZ], d = [minX, maxY, minZ];
  const e = [minX, minY, maxZ], f = [maxX, minY, maxZ], g = [maxX, maxY, maxZ], h = [minX, maxY, maxZ];
  const quads = [
    [a, b, c, d], [e, f, g, h], // z faces
    [a, e, h, d], [b, f, g, c], // x faces
    [a, b, f, e], [d, c, g, h], // y faces
  ];
  const tris = [];
  for (const [p0, p1, p2, p3] of quads) {
    tris.push([...p0, ...p1, ...p2]);
    tris.push([...p0, ...p2, ...p3]);
  }
  return tris;
}

/** Scene (i): a closed (double-shell) box, sun outside -> inside irradiance should read ~0 everywhere. */
export function buildClosedBoxScene({ half = 6, wallThickness = 1 } = {}) {
  const outer = boxTriangles(-half, 0, -half, half, 2 * half, half);
  // an inward second shell so a cellSize=1 grid always has >=1 full voxel
  // of wall thickness to catch — a single infinitely-thin quad can straddle
  // a voxel boundary and leave a gap the DDA march slips through (the same
  // AABB-overlap conservatism voxelize.js documents)
  const inner = boxTriangles(
    -half + wallThickness, wallThickness, -half + wallThickness,
    half - wallThickness, 2 * half - wallThickness, half - wallThickness,
  );
  return {
    triangles: [...outer, ...inner],
    giParams: {
      enabled: true, spacing: half, halfExtentXZ: half, layersY: 1, heightRange: [half * 0.5, half * 1.5],
      raysPerProbe: 96, irradianceRes: 4, depthRes: 4, voxelCellSize: 1, voxelMaxDist: half * 4,
      updateFraction: 1, irradianceAlpha: 0.9, depthAlpha: 0.8,
      sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 },
    },
  };
}

/** Scene (ii): an open ground plane + a small wall pillar, angled sun (so a vertical face actually gets lit). */
export function buildOpenPlaneRedWallScene({ half = 10 } = {}) {
  const ground = boxTriangles(-half, -1, -half, half, 0, half);
  const wall = boxTriangles(half - 2, 0, -2, half, 4, 2); // a pillar near +X
  return {
    triangles: [...ground, ...wall],
    giParams: {
      enabled: true, spacing: half * 0.5, halfExtentXZ: half, layersY: 1, heightRange: [0.5, 2],
      raysPerProbe: 128, irradianceRes: 4, depthRes: 4, voxelCellSize: 1, voxelMaxDist: half * 3,
      updateFraction: 1, irradianceAlpha: 0.9, depthAlpha: 0.8, albedo: 0.5,
      // travels -X: lights the pillar's +X face and the open ground alike;
      // NOTE this harness compares GPU<->CPU with the SAME flat PLACEHOLDER
      // albedo both sides (the GPU kernel has no per-voxel color in v0, see
      // docs) — it does not re-test the color-bleed formula itself, that is
      // gi-reference.test.js scene(ii-b)'s job on the CPU side only.
      sun: { direction: [-1, 0, 0], color: [1, 1, 1], intensity: 1 },
    },
  };
}

// ------------------------------------------------------------- CPU reference

/** Read a GIController's ACTUAL runtime state back into plain JS for gi-reference.js. */
function extractCpuReferenceInputs(gi) {
  const { grid, probeGrid, params: p, sun } = gi.resources;
  const origin = [probeGrid.origin.value.x, probeGrid.origin.value.y, probeGrid.origin.value.z];
  // gi-controller.js currently places every probe with a single uniform
  // `spacing` on all 3 axes (origin + [ix,iy,iz]*spacing) — NOT
  // buildProbeGrid's ySpacing/baseY layered-cascade design (docs describe
  // the intended camera-relative cascade; the kernels don't implement the
  // separate Y spacing yet, flagged in docs UNVERIFIED). This harness
  // matches what is ACTUALLY running, or it would compare against the
  // wrong probe positions and every scene would spuriously fail.
  const spacing = probeGrid.spacing;
  const dims = grid.dims;
  const occArr = voxelizeTriangles(gi._sceneTriangles, gi._voxelConfig.voxelOriginArr, gi._voxelConfig.cellSize, gi._voxelConfig.dims);
  return {
    origin, spacing, dims,
    occupancy: occArr, voxelOrigin: gi._voxelConfig.voxelOriginArr, cellSize: gi._voxelConfig.cellSize,
    sun: {
      direction: [sun.direction.value.x, sun.direction.value.y, sun.direction.value.z],
      color: [sun.color.value.x, sun.color.value.y, sun.color.value.z],
      intensity: sun.intensity.value,
    },
    raysPerProbe: p.raysPerProbe, irradianceRes: p.irradianceRes, depthRes: p.depthRes,
    maxDist: p.voxelMaxDist, albedo: p.albedo, skyColor: p.skyColor,
  };
}

function computeCpuReferenceAtlas(cfg) {
  const { dims, origin, spacing, irradianceRes } = cfg;
  const texelsPerProbe = irradianceRes * irradianceRes;
  const flat = new Float32Array(dims.x * dims.y * dims.z * texelsPerProbe * 3);
  for (let iz = 0; iz < dims.z; iz++) {
    for (let iy = 0; iy < dims.y; iy++) {
      for (let ix = 0; ix < dims.x; ix++) {
        const pIdx = probeIndex(ix, iy, iz, dims);
        const probePos = [origin[0] + ix * spacing, origin[1] + iy * spacing, origin[2] + iz * spacing];
        const { irradianceTexels } = referenceUpdateProbe({
          probePos, occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims,
          maxDist: cfg.maxDist, raysPerProbe: cfg.raysPerProbe, rotation: null,
          sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor,
          irradianceRes, depthRes: cfg.depthRes,
        });
        for (let t = 0; t < texelsPerProbe; t++) {
          const base = (pIdx * texelsPerProbe + t) * 3;
          flat[base] = irradianceTexels[t][0];
          flat[base + 1] = irradianceTexels[t][1];
          flat[base + 2] = irradianceTexels[t][2];
        }
      }
    }
  }
  return flat;
}

// ------------------------------------------------------------- browser orchestration
// Everything below actually touches a WebGPU device. Only called from
// tools/gi-parity.html in a real browser; importing this module (as the
// node-side test does) never executes any of it.

async function defaultRendererFactory() {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  return renderer;
}

/** Run one scene end to end: build it, drive K real updates, read the GPU atlas back, compare to the CPU reference. */
export async function runScene(name, sceneBuilder, { rendererFactory } = {}) {
  const { triangles, giParams } = sceneBuilder();
  const renderer = await (rendererFactory ?? defaultRendererFactory)();
  const scene = new THREE.Scene();
  const gi = new GIController({ renderer, scene });
  gi.configure(giParams);
  gi.setSceneTriangles(triangles);

  const K = computeUpdateCount({ updateFraction: giParams.updateFraction, alpha: giParams.irradianceAlpha });
  for (let i = 0; i < K; i++) gi.update(1 / 60, [0, 0, 0]);

  const attr = gi.resources.atlases.irradiance.value; // StorageInstancedBufferAttribute
  const buf = await renderer.getArrayBufferAsync(attr);
  const actual = new Float32Array(buf);

  const cfg = extractCpuReferenceInputs(gi);
  const expected = computeCpuReferenceAtlas(cfg);

  const cmp = compareAtlas(actual, expected);
  return { scene: name, updates: K, probes: cfg.dims.x * cfg.dims.y * cfg.dims.z, tolerance: DEFAULT_TOLERANCE, ...cmp };
}

/** Run both scenes. Returns an array of results (see runScene). */
export async function runAll({ rendererFactory } = {}) {
  const scenes = [
    ['closed-box-scene-i', buildClosedBoxScene],
    ['open-plane-wall-scene-ii', buildOpenPlaneRedWallScene],
  ];
  const results = [];
  for (const [name, builder] of scenes) {
    // eslint-disable-next-line no-await-in-loop -- scenes must run sequentially, each owns its own renderer/device
    results.push(await runScene(name, builder, { rendererFactory }));
  }
  return results;
}
