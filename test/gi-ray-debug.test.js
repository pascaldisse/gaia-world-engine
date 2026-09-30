// Root-cause investigation #3 (parent live-GPU rerun, 09-29): occupancy is
// now proven identical GPU==CPU (0 mismatches both scenes). Remaining
// divergence must be in probe world positions, the ray direction set, or
// the march itself given a correct probe origin/ray. This file covers the
// pure, node-testable half of the new per-ray debug tooling
// (createRayDebugKernel's CPU mirror) + formally rules out hypothesis (a)
// "probe world position formula GPU vs CPU disagree" with a direct CPU
// mirror of the kernel's OWN ix/iy/iz decomposition + position formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decomposeProbeIndex, debugProbeRaysCPU, compareRayDebug, compareRayShading,
} from '../tools/gi-parity.mjs';
import { traceSingleRay } from '../client/kernel/gi/gi-reference.js';
import { gridToWorld, probeIndex } from '../client/kernel/gi/probe-grid.js';
import { fibonacciSphereDirs } from '../client/kernel/gi/irradiance.js';
import { marchOccupancy } from '../client/kernel/gi/voxelize.js';

// ---------------------------------------------- hypothesis (a): probe position
test('hypothesis (a) RULED OUT: the kernel\'s ix/iy/iz decomposition + position formula round-trips through probeIndex()/gridToWorld() exactly', () => {
  const dims = { x: 5, y: 2, z: 3 };
  const origin = [-10, 0.5, -4];
  const spacing = 5;
  for (let iz = 0; iz < dims.z; iz++) {
    for (let iy = 0; iy < dims.y; iy++) {
      for (let ix = 0; ix < dims.x; ix++) {
        const flatIdx = probeIndex(ix, iy, iz, dims); // probe-grid.js's own forward formula
        const decomposed = decomposeProbeIndex(flatIdx, dims); // the kernel's OWN inverse formula, mirrored
        assert.deepEqual(decomposed, { ix, iy, iz }, `round-trip failed for probeIndex ${flatIdx}`);
        const kernelPos = [origin[0] + decomposed.ix * spacing, origin[1] + decomposed.iy * spacing, origin[2] + decomposed.iz * spacing];
        const referencePos = gridToWorld(ix, iy, iz, origin, spacing); // probe-grid.js's own forward formula, used by gi-reference.js
        assert.deepEqual(kernelPos, referencePos);
      }
    }
  }
});

test('mutant: a y-fastest (instead of x-fastest) decomposeProbeIndex would desync from probeIndex()/gridToWorld() for any non-cubic grid', () => {
  const dims = { x: 5, y: 2, z: 3 };
  const yFastest = (idx) => {
    const iy = idx % dims.y;
    const ix = Math.floor(idx / dims.y) % dims.x;
    const iz = Math.floor(idx / (dims.y * dims.x));
    return { ix, iy, iz };
  };
  const flatIdx = probeIndex(2, 1, 1, dims); // = 2 + 5*(1+2*1) = 2+15 = 17
  const real = decomposeProbeIndex(flatIdx, dims);
  const mutant = yFastest(flatIdx);
  assert.notDeepEqual(real, mutant, 'the mutant must disagree with the real x-fastest decomposition');
  assert.deepEqual(real, { ix: 2, iy: 1, iz: 1 });
});

// ---------------------------------------------- debugProbeRaysCPU + compareRayDebug
function makeCfg() {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  occ[5 + dims.x * (3 + dims.y * 3)] = 1; // one occupied boundary cell (for the bounds-mirror-style tests)
  return {
    dims, origin: [0, 0, 0], spacing: 2,
    occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1,
    raysPerProbe: 24, maxDist: 10,
  };
}

/** A cfg with a WHOLE FACE occupied (guarantees at least one of a small
 *  ray sample actually hits it -- a single 1x1x1 cell subtends too tiny a
 *  solid angle at any real distance for a 24-ray fibonacci sample to
 *  reliably land on it). */
function makeCfgWithWall() {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  for (let iy = 0; iy < dims.y; iy++) for (let iz = 0; iz < dims.z; iz++) occ[5 + dims.x * (iy + dims.y * iz)] = 1; // whole +x face
  return {
    dims, origin: [0, 0, 0], spacing: 2,
    occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1,
    raysPerProbe: 24, maxDist: 10,
  };
}

test('debugProbeRaysCPU returns exactly raysToCapture rays, each with a unit direction and a hitT or null', () => {
  const cfg = makeCfg();
  const rays = debugProbeRaysCPU(0, cfg, 8);
  assert.equal(rays.length, 8);
  for (const r of rays) {
    const len = Math.hypot(...r.dir);
    assert.ok(Math.abs(len - 1) < 1e-9);
    assert.ok(r.hitT === null || typeof r.hitT === 'number');
  }
});

test('debugProbeRaysCPU uses the SAME fibonacciSphereDirs the real reference kernel uses (first N directions of the full raysPerProbe set)', () => {
  const cfg = makeCfg();
  const rays = debugProbeRaysCPU(0, cfg, 4);
  const expectedDirs = fibonacciSphereDirs(cfg.raysPerProbe, null).slice(0, 4);
  for (let i = 0; i < 4; i++) assert.deepEqual(rays[i].dir, expectedDirs[i]);
});

test('debugProbeRaysCPU uses the SAME marchOccupancy voxelize.js exports (not a re-implementation that could silently diverge)', () => {
  const cfg = makeCfg();
  const rays = debugProbeRaysCPU(0, cfg, 1);
  const expected = marchOccupancy(cfg.occupancy, cfg.dims, cfg.voxelOrigin, cfg.cellSize, [0, 0, 0], rays[0].dir, cfg.maxDist);
  assert.equal(rays[0].hitT, expected);
});

test('compareRayDebug: identical GPU/CPU rays pass with zero mismatches', () => {
  const cfg = makeCfg();
  const cpuRays = debugProbeRaysCPU(0, cfg, 4);
  const actual = new Float32Array(4 * 4);
  cpuRays.forEach((r, i) => {
    actual[i * 4] = r.dir[0]; actual[i * 4 + 1] = r.dir[1]; actual[i * 4 + 2] = r.dir[2];
    actual[i * 4 + 3] = r.hitT === null ? -1 : r.hitT;
  });
  const cmp = compareRayDebug(actual, cpuRays);
  assert.equal(cmp.pass, true);
  assert.equal(cmp.mismatches.length, 0);
});

test('compareRayDebug: a GPU direction that diverges from CPU is flagged with both values', () => {
  const cfg = makeCfg();
  // ray index 5 (not 0): the fibonacci sequence's first ray (i=0) sits
  // exactly at the pole (dir=[0,1,0], x=z=0), where a "sign flip" mutant
  // is indistinguishable from the original -- pick an index with a
  // genuinely nonzero x component instead
  const cpuRays = debugProbeRaysCPU(0, cfg, 6);
  assert.notEqual(cpuRays[5].dir[0], 0, 'sanity: ray 5 has a nonzero x component');
  const actual = new Float32Array(6 * 4);
  cpuRays.forEach((r, i) => {
    const flip = i === 5 ? -1 : 1; // BUG: ray 5's x sign flipped
    actual[i * 4] = r.dir[0] * flip; actual[i * 4 + 1] = r.dir[1]; actual[i * 4 + 2] = r.dir[2];
    actual[i * 4 + 3] = r.hitT === null ? -1 : r.hitT;
  });
  const cmp = compareRayDebug(actual, cpuRays);
  assert.equal(cmp.pass, false);
  assert.equal(cmp.mismatches.length, 1);
  assert.equal(cmp.mismatches[0].ray, 5);
});

test('compareRayDebug: hit vs miss classification (not just distance) is compared -- a GPU miss (t<0) where CPU expects a hit is flagged even if some other ray with the same distance coincidentally matches', () => {
  const cfg = makeCfgWithWall();
  const rays = debugProbeRaysCPU(0, cfg, 24);
  const hitIdx = rays.findIndex((r) => r.hitT !== null);
  assert.ok(hitIdx !== -1, 'sanity: at least one of the 24 rays should hit the occupied boundary cell');
  const actual = new Float32Array(24 * 4);
  rays.forEach((r, i) => {
    actual[i * 4] = r.dir[0]; actual[i * 4 + 1] = r.dir[1]; actual[i * 4 + 2] = r.dir[2];
    actual[i * 4 + 3] = i === hitIdx ? -1 : (r.hitT === null ? -1 : r.hitT); // BUG: force the known-hit ray to report miss
  });
  const cmp = compareRayDebug(actual, rays);
  assert.equal(cmp.pass, false);
  assert.ok(cmp.mismatches.some((m) => m.ray === hitIdx));
});

test('mutant: comparing only hitT numerically (ignoring the null/miss vs negative-number encoding) would silently accept a hit reported as a huge negative distance instead of a proper miss flag', () => {
  const numericOnly = (gpuT, cpuT) => Math.abs(gpuT - (cpuT ?? -1)) < 1; // BUG: -1 sentinel vs an actual small negative distance are conflated numerically for small |t|
  assert.equal(numericOnly(-0.5, null), true, 'a mutant comparator would accept -0.5 as "close enough" to the -1 miss sentinel, even though -0.5 is not how misses are actually encoded');
});

// --------------------------------------------------------- traceSingleRay + compareRayShading
// (parent review 09-29, 4th pass: "extend rayDebug with per-ray radiance +
// shadowT + normal")
test('traceSingleRay: a miss returns hit:false, N:null, shadowT:null, radiance:skyColor', () => {
  const cfg = makeCfg();
  const r = traceSingleRay({ probePos: [0, 0, 0], dir: [1, 0, 0], occupancy: new Uint8Array(cfg.dims.x * cfg.dims.y * cfg.dims.z), voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.dims, maxDist: cfg.maxDist, skyColor: [0.4, 0.5, 0.7] });
  assert.equal(r.hit, false);
  assert.equal(r.N, null);
  assert.equal(r.shadowT, null);
  assert.deepEqual(r.radiance, [0.4, 0.5, 0.7]);
});

test('traceSingleRay: a lit hit (N faces the sun, shadow march finds nothing) returns shadowT:null (meaning unshadowed) and nonzero radiance', () => {
  const cfg = makeCfgWithWall(); // +x face occupied
  const sun = { direction: [1, 0, 0], color: [1, 1, 1], intensity: 1 }; // travels +x -> lights the wall's -x face... use a probe on the -x side
  const r = traceSingleRay({
    probePos: [0, 3, 3], dir: [1, 0, 0], occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.dims, maxDist: cfg.maxDist,
    sun, albedo: 0.5, skyColor: [0.4, 0.5, 0.7],
  });
  assert.equal(r.hit, true);
  assert.ok(r.N.every((v, i) => Math.abs(v - [-1, 0, 0][i]) < 1e-12), `N should be -dir, got ${r.N}`); // N = -dir (avoid -0 !== 0 under deepEqual)
  assert.equal(r.shadowT, null, 'unshadowed -> null, not a numeric "no hit" sentinel');
  assert.ok(r.radiance[0] > 0, `expected positive lit radiance, got ${r.radiance}`);
});

test('traceSingleRay: a hit whose N faces AWAY from the sun (ndotl<=0) never even enters the shadow march -- shadowT stays null, radiance is legitimately 0', () => {
  const cfg = makeCfgWithWall();
  const sun = { direction: [-1, 0, 0], color: [1, 1, 1], intensity: 1 }; // travels -x -> hits the wall's OWN face from the wrong side for this probe
  const r = traceSingleRay({
    probePos: [0, 3, 3], dir: [1, 0, 0], occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.dims, maxDist: cfg.maxDist,
    sun, albedo: 0.5, skyColor: [0.4, 0.5, 0.7],
  });
  assert.equal(r.hit, true);
  assert.deepEqual(r.radiance, [0, 0, 0], 'N faces away from this sun direction -> legitimately unlit, not a bug');
  assert.equal(r.shadowT, null, 'the shadow branch was never entered (ndotl<=0), so shadowT has no meaning here -- distinct from "entered and found nothing"');
});

test('compareRayShading: identical GPU/CPU shading passes with zero mismatches', () => {
  const cfg = makeCfgWithWall();
  const sun = { direction: [1, 0, 0], color: [1, 1, 1], intensity: 1 };
  const cpuRays = [0, 1].map(() => traceSingleRay({ probePos: [0, 3, 3], dir: [1, 0, 0], occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.dims, maxDist: cfg.maxDist, sun, albedo: 0.5, skyColor: [0.4, 0.5, 0.7] }));
  const radianceFlat = new Float32Array(2 * 4);
  const normalFlat = new Float32Array(2 * 4);
  cpuRays.forEach((r, i) => {
    radianceFlat[i * 4] = r.radiance[0]; radianceFlat[i * 4 + 1] = r.radiance[1]; radianceFlat[i * 4 + 2] = r.radiance[2];
    radianceFlat[i * 4 + 3] = r.shadowT === null ? -1 : r.shadowT;
    normalFlat[i * 4] = r.N[0]; normalFlat[i * 4 + 1] = r.N[1]; normalFlat[i * 4 + 2] = r.N[2];
    normalFlat[i * 4 + 3] = 1; // hit
  });
  const cmp = compareRayShading(radianceFlat, normalFlat, cpuRays);
  assert.equal(cmp.pass, true);
});

test('compareRayShading: a GPU radiance stuck at 0 where CPU expects a lit value is flagged (the exact live symptom, parent 09-29 4th pass)', () => {
  const cfg = makeCfgWithWall();
  const sun = { direction: [1, 0, 0], color: [1, 1, 1], intensity: 1 };
  const cpuRay = traceSingleRay({ probePos: [0, 3, 3], dir: [1, 0, 0], occupancy: cfg.occupancy, voxelOrigin: cfg.voxelOrigin, cellSize: cfg.cellSize, dims: cfg.dims, maxDist: cfg.maxDist, sun, albedo: 0.5, skyColor: [0.4, 0.5, 0.7] });
  assert.ok(cpuRay.radiance[0] > 0, 'sanity: CPU really does expect a lit (nonzero) radiance here');
  const radianceFlat = new Float32Array([0, 0, 0, -1]); // BUG: GPU reports zero radiance, claims unshadowed
  const normalFlat = new Float32Array([...cpuRay.N, 1]);
  const cmp = compareRayShading(radianceFlat, normalFlat, [cpuRay]);
  assert.equal(cmp.pass, false);
  assert.equal(cmp.mismatches[0].ray, 0);
});

test('mutant: a shading comparator that only checks hit/miss + normal (not radiance itself) would MISS the live "radiance stuck at 0" symptom entirely', () => {
  const hitOnlyCompare = (gpuHit, cpuHit, gpuN, cpuN) => gpuHit === cpuHit && Math.hypot(...gpuN.map((v, i) => v - cpuN[i])) < 1e-4; // BUG: never looks at radiance
  const gpuN = [-1, 0, 0], cpuN = [-1, 0, 0];
  assert.equal(hitOnlyCompare(true, true, gpuN, cpuN), true, 'the mutant would pass even though GPU radiance is stuck at 0 and CPU expects a lit value -- exactly the bug this scenario represents');
});
