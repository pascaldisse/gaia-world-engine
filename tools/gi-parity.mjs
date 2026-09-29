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
import { createRayDebugKernel } from '../client/kernel/gi/gi-nodes.js';
import { referenceUpdateProbe, traceSingleRay } from '../client/kernel/gi/gi-reference.js';
import { voxelizeTriangles } from '../client/kernel/gi/voxelize.js';
import { probeIndex } from '../client/kernel/gi/probe-grid.js';
import { fibonacciSphereDirs } from '../client/kernel/gi/irradiance.js';
import { decodeOct } from '../client/kernel/gi/octahedral.js';

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
// § WGSL storage vec3 is padded to 16 bytes → GPU readback = 4 floats/texel; CPU reference = 3 (live run 09-29: 576 vs 432).
export function unpadVec3(a, expectedLength) {
  if (a.length === expectedLength || a.length !== expectedLength / 3 * 4) return a;
  const out = new Float32Array(expectedLength);
  for (let i = 0, j = 0; j < expectedLength; i += 4, j += 3) { out[j] = a[i]; out[j + 1] = a[i + 1]; out[j + 2] = a[i + 2]; }
  return out;
}

/**
 * Elementwise compare the GPU occupancy storage buffer's readback (uint32,
 * one element per cell -- NO vec3-style padding, scalars pack tightly in
 * WGSL storage arrays) against the CPU voxelize.js output for the SAME
 * scene. Pure, GPU-free -- the actual GPU array is read by runScene() and
 * handed to this function. §GI-PROBES.md, parent review 09-29 2nd pass.
 */
export function compareOccupancy(actualUint32, expectedUint8) {
  if (actualUint32.length !== expectedUint8.length) {
    return { mismatches: -1, firstMismatchIndex: -1, total: 0, reason: `length mismatch: ${actualUint32.length} vs ${expectedUint8.length}` };
  }
  let mismatches = 0;
  let firstMismatchIndex = -1;
  for (let i = 0; i < actualUint32.length; i++) {
    const a = actualUint32[i] ? 1 : 0;
    const e = expectedUint8[i] ? 1 : 0;
    if (a !== e) {
      mismatches++;
      if (firstMismatchIndex === -1) firstMismatchIndex = i;
    }
  }
  return { mismatches, firstMismatchIndex, total: actualUint32.length };
}

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
      // PLACEHOLDER, reduced 09-29 after a live headless-Brave run showed a
      // scattered incomplete-write pattern (most probes never touched, a
      // few correct, one partial) consistent with a per-dispatch GPU
      // timeout/TDR under a software/headless WebGPU backend, not a logic
      // bug (see docs + the gi-kernel-index-mirror fixes committed
      // alongside this change, which fix real bugs but don't reproduce
      // THIS specific failure). Cutting raysPerProbe (96->24) shrinks total
      // per-thread march-loop work ~4x; updateFraction<1 makes the NEW
      // per-call explicit dispatch-count fix (gi-controller.js update())
      // actually shrink each individual compute pass instead of always
      // dispatching the full grid, reducing any SINGLE dispatch's chance of
      // tripping a per-call watchdog. Unverified whether this is sufficient
      // -- Pascal's next live run is the actual test.
      raysPerProbe: 24, irradianceRes: 4, depthRes: 4, voxelCellSize: 1, voxelMaxDist: half * 4,
      updateFraction: 1 / 3, irradianceAlpha: 0.9, depthAlpha: 0.8,
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
      // PLACEHOLDER, reduced 09-29 -- see buildClosedBoxScene's comment,
      // same reasoning (raysPerProbe 128->32, updateFraction 1->1/5)
      raysPerProbe: 32, irradianceRes: 4, depthRes: 4, voxelCellSize: 1, voxelMaxDist: half * 3,
      updateFraction: 1 / 5, irradianceAlpha: 0.9, depthAlpha: 0.8, albedo: 0.5,
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
    origin, spacing, dims, voxelDims: gi._voxelConfig.dims,
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
          probePos, occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims ?? dims,
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

// ---------------------------------------------------------------- ray debug
// Per-ray debug trace (parent review 09-29, 3rd pass): for a SPECIFIC
// probe index, the exact first-N ray directions + first-hit distances,
// GPU (createRayDebugKernel, real dispatch) vs a pure CPU mirror using the
// SAME probe-index decomposition, fibonacciSphereDirs, and marchOccupancy.

/** Flat probeIdx -> (ix,iy,iz), the SAME decomposition gi-nodes.js's
 *  kernels use (ix=probeIdx%dims.x, iy=floor(probeIdx/dims.x)%dims.y,
 *  iz=floor(probeIdx/(dims.x*dims.y))). Pure, node-testable. */
export function decomposeProbeIndex(probeIdx, dims) {
  const ix = probeIdx % dims.x;
  const iy = Math.floor(probeIdx / dims.x) % dims.y;
  const iz = Math.floor(probeIdx / (dims.x * dims.y));
  return { ix, iy, iz };
}

/**
 * Pure CPU mirror of createRayDebugKernel: for `probeIdx`, the first
 * `raysToCapture` fibonacci ray directions (rotation=null, matching the
 * harness's static ray set throughout) + each ray's marchOccupancy hit
 * distance against `cfg.occupancy`. Pure, node-testable.
 */
export function debugProbeRaysCPU(probeIdx, cfg, raysToCapture) {
  const { ix, iy, iz } = decomposeProbeIndex(probeIdx, cfg.dims);
  const probePos = [cfg.origin[0] + ix * cfg.spacing, cfg.origin[1] + iy * cfg.spacing, cfg.origin[2] + iz * cfg.spacing];
  const dirs = fibonacciSphereDirs(cfg.raysPerProbe, null).slice(0, raysToCapture);
  // traceSingleRay (gi-reference.js) does the FULL shade (shadow march,
  // N, radiance) -- the single source of truth traceProbeRays itself uses,
  // so this debug trace can never silently drift from the real baked atlas
  return dirs.map((dir) => traceSingleRay({
    probePos, dir,
    occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims ?? cfg.dims, maxDist: cfg.maxDist,
    sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor,
  }));
}

/**
 * Compare a GPU ray-debug readback (Float32Array, 4 floats/ray: dir.xyz +
 * hitT, vec4 so no storage-padding quirk) against debugProbeRaysCPU's
 * output for the same probe. Pure, node-testable.
 */
export function compareRayDebug(actualVec4Flat, cpuRays, tolerance = { dirTol: 1e-4, distTol: 1e-2, radianceTol: 5e-2 }) {
  const mismatches = [];
  for (let i = 0; i < cpuRays.length; i++) {
    const gx = actualVec4Flat[i * 4], gy = actualVec4Flat[i * 4 + 1], gz = actualVec4Flat[i * 4 + 2], gt = actualVec4Flat[i * 4 + 3];
    const { dir, hitT } = cpuRays[i];
    const dirErr = Math.hypot(gx - dir[0], gy - dir[1], gz - dir[2]);
    const cpuMiss = hitT === null;
    const gpuMiss = gt < 0;
    const distOk = cpuMiss || gpuMiss ? cpuMiss === gpuMiss : Math.abs(gt - hitT) <= tolerance.distTol;
    if (dirErr > tolerance.dirTol || !distOk) {
      mismatches.push({ ray: i, gpuDir: [gx, gy, gz], cpuDir: dir, gpuHitT: gt, cpuHitT: hitT, cpuMiss, gpuMiss });
    }
  }
  return { pass: mismatches.length === 0, mismatches, total: cpuRays.length };
}

/**
 * Compare the radiance/shadowT/N buffers (parent review 09-29, 4th pass:
 * "extend rayDebug with per-ray radiance + shadowT + normal"). Pure,
 * node-testable -- reads the SAME flat vec4 layout createRayDebugKernel
 * writes (radianceBuffer: radiance.xyz+shadowT; normalBuffer: N.xyz+hit).
 */
export function compareRayShading(radianceFlat, normalFlat, cpuRays, tolerance = { radianceTol: 5e-2, normalTol: 1e-4, shadowTTol: 1e-2 }) {
  const mismatches = [];
  for (let i = 0; i < cpuRays.length; i++) {
    const gr = [radianceFlat[i * 4], radianceFlat[i * 4 + 1], radianceFlat[i * 4 + 2]];
    const gShadowT = radianceFlat[i * 4 + 3];
    const gN = [normalFlat[i * 4], normalFlat[i * 4 + 1], normalFlat[i * 4 + 2]];
    const gHit = normalFlat[i * 4 + 3] !== 0;
    const cpu = cpuRays[i];
    const radianceErr = Math.hypot(gr[0] - cpu.radiance[0], gr[1] - cpu.radiance[1], gr[2] - cpu.radiance[2]);
    const radianceMag = Math.hypot(...cpu.radiance) || 1;
    const radianceOk = radianceErr <= tolerance.radianceTol * Math.max(1, radianceMag);
    // GPU shadowT encoding: -2 = "no sun configured" sentinel (traceAndShadeRayTSL),
    // -1 = shadow march found nothing (unshadowed/lit), >=0 = shadow hit distance.
    let normalOk = true, shadowTOk = true;
    if (cpu.hit) {
      const normalErr = Math.hypot(gN[0] - cpu.N[0], gN[1] - cpu.N[1], gN[2] - cpu.N[2]);
      normalOk = normalErr <= tolerance.normalTol;
      if (gShadowT !== -2) {
        const cpuShadowed = cpu.shadowT !== null;
        const gpuShadowed = gShadowT >= 0;
        shadowTOk = cpuShadowed === gpuShadowed && (!cpuShadowed || Math.abs(gShadowT - cpu.shadowT) <= tolerance.shadowTTol);
      }
    }
    if (!radianceOk || !normalOk || !shadowTOk || gHit !== cpu.hit) {
      mismatches.push({
        ray: i, gpuRadiance: gr, cpuRadiance: cpu.radiance, gpuShadowT: gShadowT, cpuShadowT: cpu.shadowT,
        gpuN: gN, cpuN: cpu.N, gpuHit: gHit, cpuHit: cpu.hit,
      });
    }
  }
  return { pass: mismatches.length === 0, mismatches, total: cpuRays.length };
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

/**
 * Dispatch the real ray-debug kernel for ONE probe, read its vec4 buffer
 * back, and compare to debugProbeRaysCPU for the same probe. Reuses the
 * live `gi`'s occ/probeGrid (must already be configure()+setSceneTriangles
 * +at least one update() so probeGrid.origin is recentered/settled).
 */
async function debugProbeRaysGPU(gi, renderer, probeIdx, raysToCapture, giParams, cfg) {
  const { sun } = gi.resources; // the SAME live uniforms the real kernels use
  const dbg = createRayDebugKernel({
    occ: gi.resources.occ, probeGrid: gi.resources.probeGrid,
    raysPerProbe: giParams.raysPerProbe, raysToCapture, maxDist: giParams.voxelMaxDist,
    sun, albedo: giParams.albedo, skyColor: giParams.skyColor,
  });
  dbg.probeIdxUniform.value = probeIdx;
  renderer.compute(dbg.kernel);
  const buf = await renderer.getArrayBufferAsync(dbg.debugBuffer.value);
  const actual = new Float32Array(buf);
  const posBuf = await renderer.getArrayBufferAsync(dbg.posDebugBuffer.value);
  const gpuWorldPos = Array.from(new Float32Array(posBuf)).slice(0, 3);
  const radianceBuf = await renderer.getArrayBufferAsync(dbg.radianceBuffer.value);
  const normalBuf = await renderer.getArrayBufferAsync(dbg.normalBuffer.value);
  const cpuRays = debugProbeRaysCPU(probeIdx, cfg, raysToCapture);
  const dirCmp = compareRayDebug(actual, cpuRays);
  const shadingCmp = compareRayShading(new Float32Array(radianceBuf), new Float32Array(normalBuf), cpuRays);
  return {
    probeIdx, gpuWorldPos,
    pass: dirCmp.pass && shadingCmp.pass,
    dirMismatches: dirCmp.mismatches, shadingMismatches: shadingCmp.mismatches,
    total: dirCmp.total,
  };
}

/** Run one scene end to end: build it, drive K real updates, read the GPU atlas back, compare to the CPU reference. */
export async function runScene(name, sceneBuilder, { rendererFactory, debugProbeIndices = [], raysToCapture = null } = {}) {
  const { triangles, giParams } = sceneBuilder();
  // default: capture the FULL ray set, not a truncated prefix -- the
  // fibonacci ordering is y-descending (top pole to bottom pole), so a
  // short prefix like 16-of-24 is systematically biased toward
  // upward-facing rays and can show "all zero radiance" for reasons that
  // have nothing to do with a GPU/CPU divergence (every one of those rays
  // legitimately has N.dot(sunDir) < 0 under a straight-down sun) --
  // found while investigating the parent's radiance-mismatch report 09-29.
  const effectiveRaysToCapture = raysToCapture ?? giParams.raysPerProbe;
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

  // parity-harness diagnostic (parent review 09-29): per-probe "was this
  // slot ever actually written by a real dispatch" flag, uint32 scalar
  // array (no vec3-padding quirk -- that's a vec3-specific std430 layout
  // rule, a plain array<u32> is tightly packed) -- distinguishes "never
  // ran" from "legitimately converged to 0" (scene(i)'s closed box has
  // BOTH kinds of zero in the same result).
  const touchedAttr = gi.resources.touched.value;
  const touchedBuf = await renderer.getArrayBufferAsync(touchedAttr);
  const written = Array.from(new Uint32Array(touchedBuf)).map((v) => v !== 0);

  // parity-harness diagnostic (parent review 09-29, 2nd pass): per-probe
  // sky (miss) ray count, approximate (see createSkyHitsBuffer's doc)
  const skyHitsAttr = gi.resources.skyHits.value;
  const skyHitsBuf = await renderer.getArrayBufferAsync(skyHitsAttr);
  const skyHits = Array.from(new Uint32Array(skyHitsBuf));

  const cfg = extractCpuReferenceInputs(gi);
  const expected = computeCpuReferenceAtlas(cfg);

  // occupancy readback vs the CPU voxelize.js output for the identical
  // scene -- the direct test of "did the GPU end up marching against the
  // SAME solid geometry the CPU reference used"
  const occAttr = gi.resources.occ.occupancy.value;
  const occBuf = await renderer.getArrayBufferAsync(occAttr);
  const occActual = new Uint32Array(occBuf);
  const occCompare = compareOccupancy(occActual, cfg.occupancy);

  const cmp = compareAtlas(unpadVec3(actual, expected.length), expected);
  cmp.expectedMax = Math.max(...expected); cmp.actualMax = Math.max(...unpadVec3(actual, expected.length));
  const per = arr => { const n = cfg.dims.x * cfg.dims.y * cfg.dims.z, k = arr.length / n; return Array.from({ length: n }, (_, p) => +arr.slice(p * k, (p + 1) * k).reduce((x, y) => x + y, 0).toFixed(3)); };
  cmp.perProbeActual = per(unpadVec3(actual, expected.length)); cmp.perProbeExpected = per(expected); cmp.probePositions = cfg.probePositions ?? null;
  cmp.written = written;
  cmp.writtenCount = written.filter(Boolean).length;
  cmp.skyHits = skyHits;
  cmp.occupancy = occCompare;

  // per-ray debug trace (parent review 09-29, 3rd pass): only for the
  // explicitly requested probe indices (cheap, small dispatches) -- world
  // position + first raysToCapture ray dirs/hitTs, GPU vs CPU mirror
  if (debugProbeIndices.length > 0) {
    cmp.rayDebug = [];
    for (const probeIdx of debugProbeIndices) {
      const { ix, iy, iz } = decomposeProbeIndex(probeIdx, cfg.dims);
      const cpuWorldPos = [cfg.origin[0] + ix * cfg.spacing, cfg.origin[1] + iy * cfg.spacing, cfg.origin[2] + iz * cfg.spacing];
      // eslint-disable-next-line no-await-in-loop -- small, sequential, diagnostic-only
      const trace = await debugProbeRaysGPU(gi, renderer, probeIdx, effectiveRaysToCapture, giParams, cfg);
      const posErr = Math.hypot(...trace.gpuWorldPos.map((v, k) => v - cpuWorldPos[k]));
      cmp.rayDebug.push({ ...trace, cpuWorldPos, positionsMatch: posErr < 1e-4 });
    }
  }

  return { scene: name, updates: K, probes: cfg.dims.x * cfg.dims.y * cfg.dims.z, tolerance: DEFAULT_TOLERANCE, ...cmp };
}

/**
 * Isolate the ATLAS KERNEL's raw per-dispatch integration from hysteresis
 * convergence and round-robin batching (parent review 09-29, 5th pass:
 * "GPU per-probe single-update irradiance (1 update, hysteresis 0) vs CPU
 * same"). Forces `irradianceAlpha:0` (mix(new,old,0)=new exactly, no
 * blend-in of the fresh-zero initial atlas) and `updateFraction:1` (one
 * update() call covers the WHOLE grid, no round-robin subset/probeOffset
 * complexity) so a single `gi.update()` call's GPU atlas readback is
 * DIRECTLY comparable to `referenceUpdateProbe`'s raw CPU result (which
 * has no hysteresis concept at all -- every call is already a fresh
 * integral). If this still diverges, the bug is in the kernel's raw
 * Loop+weighted-sum+MC-normalize accumulation itself; if it MATCHES, the
 * bug is specific to the multi-iteration hysteresis/round-robin path.
 */
// -------------------------------------------------- (A)(C) real-kernel instrumentation
// parent review 09-29, 7th pass: "stop inferring from sibling kernels,
// instrument the REAL update kernel". Pure CPU half first (node-testable);
// the GPU half (runSingleUpdateCheck's debugProbeIndices option, below)
// reads back createGIUpdateKernel's own debugDirHit/debugRadianceWeight/
// debugRunningSum/debugFinal/probeMapBuffer and diffs them against this.

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Step-by-step CPU trace of EXACTLY what the update kernel computes for one
 * probe's texel 0: for each ray, {dir, dist, radiance, weight, runningSum},
 * plus the final MC-normalized estimate -- using the SAME traceSingleRay +
 * texel-0 octahedral direction + MC normalization the real kernel uses.
 */
export function cpuStepByStepTrace(probeIdx, cfg) {
  const { ix, iy, iz } = decomposeProbeIndex(probeIdx, cfg.dims);
  const probePos = [cfg.origin[0] + ix * cfg.spacing, cfg.origin[1] + iy * cfg.spacing, cfg.origin[2] + iz * cfg.spacing];
  const res = cfg.irradianceRes;
  // texel 0: tu=0%res=0, tv=0/res=0 -- SAME formula createGIUpdateKernel uses
  const octu = ((0 + 0.5) / res) * 2 - 1;
  const octv = ((0 + 0.5) / res) * 2 - 1;
  const texelDir = decodeOct([octu, octv]);
  const dirs = fibonacciSphereDirs(cfg.raysPerProbe, null);
  let runningSum = [0, 0, 0];
  const steps = dirs.map((dir, i) => {
    const ray = traceSingleRay({
      probePos, dir, occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.voxelDims ?? cfg.dims,
      maxDist: cfg.maxDist, sun: cfg.sun, albedo: cfg.albedo, skyColor: cfg.skyColor,
    });
    const weight = Math.max(0, dot3(texelDir, dir));
    runningSum = [runningSum[0] + weight * ray.radiance[0], runningSum[1] + weight * ray.radiance[1], runningSum[2] + weight * ray.radiance[2]];
    return { rayIndex: i, dir, dist: ray.dist, radiance: ray.radiance, weight, runningSum: [...runningSum] };
  });
  const mcNorm = (4 * Math.PI) / cfg.raysPerProbe;
  const finalEstimate = runningSum.map((v) => v * mcNorm);
  return { probePos, texelDir, steps, finalEstimate };
}

/**
 * Diff a GPU per-ray trace (read back from createGIUpdateKernel's debug
 * buffers) against cpuStepByStepTrace's steps, ray by ray, reporting the
 * FIRST diverging ray/field (not just an aggregate pass/fail). Pure,
 * node-testable.
 */
export function compareStepByStepTrace(gpuSteps, cpuSteps, gpuFinal, cpuFinal, tolerance = { dirTol: 1e-3, distTol: 5e-2, radianceTol: 5e-2, weightTol: 1e-3, sumTol: 1e-1 }) {
  let firstDivergingRay = -1;
  const fields = [];
  for (let i = 0; i < cpuSteps.length; i++) {
    const g = gpuSteps[i];
    const c = cpuSteps[i];
    if (!g) { firstDivergingRay = i; fields.push('missing GPU ray'); break; }
    const dirErr = Math.hypot(...g.dir.map((v, k) => v - c.dir[k]));
    const distErr = Math.abs(g.dist - c.dist);
    const radErr = Math.hypot(...g.radiance.map((v, k) => v - c.radiance[k]));
    const weightErr = Math.abs(g.weight - c.weight);
    const sumErr = Math.hypot(...g.runningSum.map((v, k) => v - c.runningSum[k]));
    const bad = [];
    if (dirErr > tolerance.dirTol) bad.push('dir');
    if (distErr > tolerance.distTol) bad.push('dist');
    if (radErr > tolerance.radianceTol) bad.push('radiance');
    if (weightErr > tolerance.weightTol) bad.push('weight');
    if (sumErr > tolerance.sumTol) bad.push('runningSum');
    if (bad.length > 0 && firstDivergingRay === -1) {
      firstDivergingRay = i;
      fields.push(...bad);
    }
  }
  const finalErr = Math.hypot(...gpuFinal.map((v, k) => v - cpuFinal[k]));
  const finalMatch = finalErr <= tolerance.radianceTol * Math.max(1, Math.hypot(...cpuFinal));
  return { pass: firstDivergingRay === -1 && finalMatch, firstDivergingRay, divergingFields: fields, gpuFinal, cpuFinal, finalMatch };
}

export async function runSingleUpdateCheck(name, sceneBuilder, { rendererFactory, debugProbeIndices = [] } = {}) {
  const { triangles, giParams: baseParams } = sceneBuilder();
  const giParams = { ...baseParams, irradianceAlpha: 0, depthAlpha: 0, updateFraction: 1 };
  const renderer = await (rendererFactory ?? defaultRendererFactory)();
  const scene = new THREE.Scene();
  const gi = new GIController({ renderer, scene });
  gi.configure(giParams);
  gi.setSceneTriangles(triangles);

  gi.update(1 / 60, [0, 0, 0]); // EXACTLY one update -- no convergence loop

  const attr = gi.resources.atlases.irradiance.value;
  const buf = await renderer.getArrayBufferAsync(attr);
  const actual = new Float32Array(buf);

  const cfg = extractCpuReferenceInputs(gi);
  const expected = computeCpuReferenceAtlas(cfg); // no hysteresis concept on the CPU side -- already the raw single-pass integral

  const cmp = compareAtlas(unpadVec3(actual, expected.length), expected);
  const per = (arr) => { const n = cfg.dims.x * cfg.dims.y * cfg.dims.z, k = arr.length / n; return Array.from({ length: n }, (_, p) => +arr.slice(p * k, (p + 1) * k).reduce((x, y) => x + y, 0).toFixed(3)); };
  cmp.perProbeActual = per(unpadVec3(actual, expected.length));
  cmp.perProbeExpected = per(expected);

  // (A)(C) real-kernel instrumentation (parent review 09-29, 7th pass):
  // re-run the (idempotent at alpha=0) single update once per requested
  // debug probe, with debugProbeUniform set, then read back the REAL
  // update kernel's own per-ray trace + probe->position map and diff
  // against a CPU step-by-step trace. Reports the FIRST diverging ray.
  if (debugProbeIndices.length > 0) {
    cmp.instrumented = [];
    for (const probeIdx of debugProbeIndices) {
      gi.resources.irr.debugProbeUniform.value = probeIdx;
      // eslint-disable-next-line no-await-in-loop -- sequential, diagnostic-only
      gi.update(1 / 60, [0, 0, 0]); // re-run: same inputs + alpha=0 -> same atlas, freshly populates this probe's debug buffers

      // eslint-disable-next-line no-await-in-loop
      const probeMapBuf = await renderer.getArrayBufferAsync(gi.resources.irr.probeMapBuffer.value);
      const probeMapArr = new Float32Array(probeMapBuf);
      const gpuProbePos = [probeMapArr[probeIdx * 4], probeMapArr[probeIdx * 4 + 1], probeMapArr[probeIdx * 4 + 2]];
      const gpuProbeIdxAsReadBack = probeMapArr[probeIdx * 4 + 3];

      // eslint-disable-next-line no-await-in-loop
      const [dirHitBuf, radWBuf, runSumBuf, finalBuf] = await Promise.all([
        renderer.getArrayBufferAsync(gi.resources.irr.debugDirHit.value),
        renderer.getArrayBufferAsync(gi.resources.irr.debugRadianceWeight.value),
        renderer.getArrayBufferAsync(gi.resources.irr.debugRunningSum.value),
        renderer.getArrayBufferAsync(gi.resources.irr.debugFinal.value),
      ]);
      const dirHit = new Float32Array(dirHitBuf), radW = new Float32Array(radWBuf), runSum = new Float32Array(runSumBuf), final = new Float32Array(finalBuf);
      const gpuSteps = [];
      for (let i = 0; i < giParams.raysPerProbe; i++) {
        gpuSteps.push({
          rayIndex: i,
          dir: [dirHit[i * 4], dirHit[i * 4 + 1], dirHit[i * 4 + 2]], dist: dirHit[i * 4 + 3],
          radiance: [radW[i * 4], radW[i * 4 + 1], radW[i * 4 + 2]], weight: radW[i * 4 + 3],
          runningSum: [runSum[i * 4], runSum[i * 4 + 1], runSum[i * 4 + 2]],
        });
      }
      const cpuTrace = cpuStepByStepTrace(probeIdx, cfg);
      const stepCmp = compareStepByStepTrace(gpuSteps, cpuTrace.steps, [final[0], final[1], final[2]], cpuTrace.finalEstimate);
      const posErr = Math.hypot(...gpuProbePos.map((v, k) => v - cpuTrace.probePos[k]));
      cmp.instrumented.push({
        probeIdx, gpuProbeIdxAsReadBack, gpuProbePos, cpuProbePos: cpuTrace.probePos, positionMatch: posErr < 1e-4,
        ...stepCmp,
      });
    }
  }

  return { scene: name, updates: 1, hysteresis: 'disabled (alpha=0)', probes: cfg.dims.x * cfg.dims.y * cfg.dims.z, tolerance: DEFAULT_TOLERANCE, ...cmp };
}

/** Run both scenes. Returns an array of results (see runScene). */
export async function runAll({ rendererFactory } = {}) {
  const scenes = [
    ['closed-box-scene-i', buildClosedBoxScene, [0, 4, 8]], // 3x3 grid: a corner, the center, the opposite corner
    ['open-plane-wall-scene-ii', buildOpenPlaneRedWallScene, [0, 3, 14]], // parent's explicit choice: an interior, an edge-adjacent, and a wall-adjacent probe
  ];
  const results = [];
  for (const [name, builder, debugProbeIndices] of scenes) {
    // eslint-disable-next-line no-await-in-loop -- scenes must run sequentially, each owns its own renderer/device
    results.push(await runScene(name, builder, { rendererFactory, debugProbeIndices }));
  }
  // parent's exact request (09-29, 7th pass): scene(i) probe 4, scene(ii)
  // probes 13 AND 14 (both named -- 13 reads wrong per the live report,
  // 14 was already covered by runScene's rayDebug but gets the full
  // instrumented per-ray trace here too)
  const instrumentedProbes = { 'closed-box-scene-i': [4], 'open-plane-wall-scene-ii': [13, 14] };
  const singleUpdateResults = [];
  for (const [name, builder] of scenes) {
    // eslint-disable-next-line no-await-in-loop
    singleUpdateResults.push(await runSingleUpdateCheck(name, builder, { rendererFactory, debugProbeIndices: instrumentedProbes[name] ?? [] }));
  }
  return { scenes: results, singleUpdate: singleUpdateResults };
}
