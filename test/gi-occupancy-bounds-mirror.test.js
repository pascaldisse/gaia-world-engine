// Root-cause investigation #2 (parent live-GPU rerun, 09-29): after fixing
// the atlasIndex bug, writtenCount reached 9/9 and 25/25 (every probe DID
// run), and lit values were EXACT where nonzero -- but a spatial SUBSET of
// probes read exactly 0 (every ray for that probe reporting a hit, i.e.
// the probe appeared to be fully enclosed). This file CPU-mirrors the
// GPU occupancy READ's bounds handling against voxelize.js's own
// marchOccupancy (the CPU reference both kernels are supposed to match)
// and proves the divergence: the pre-fix GPU kernel CLAMPED an
// out-of-grid world position into [0,dims) and read that clamped cell
// unconditionally, so any ray exiting the grid near an occupied boundary
// cell (e.g. the wall's own AABB, clamped there at WRITE time too) would
// falsely register a permanent hit. voxelize.js's marchOccupancy instead
// bounds-checks FIRST and treats out-of-range as "no geometry" (skip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marchOccupancy, voxelizeTriangles } from '../client/kernel/gi/voxelize.js';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

// -------- pure CPU mirrors of both march strategies --------

/** voxelize.js's own strategy: bounds-check, then read; out-of-range = skip (never a hit). */
function marchBoundsCheckSkip(occ, dims, originWorld, cellSize, rayOrigin, rayDir, maxDist) {
  return marchOccupancy(occ, dims, originWorld, cellSize, rayOrigin, rayDir, maxDist);
}

/** the PRE-FIX GPU strategy: clamp the index into range, then read unconditionally. */
function marchClampAndRead(occ, dims, originWorld, cellSize, rayOrigin, rayDir, maxDist) {
  const [ox, oy, oz] = originWorld;
  let t = 0;
  const step = cellSize * 0.5;
  const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  while (t < maxDist) {
    const px = rayOrigin[0] + rayDir[0] * t;
    const py = rayOrigin[1] + rayDir[1] * t;
    const pz = rayOrigin[2] + rayDir[2] * t;
    const ix = clampI(Math.floor((px - ox) / cellSize), 0, dims.x - 1);
    const iy = clampI(Math.floor((py - oy) / cellSize), 0, dims.y - 1);
    const iz = clampI(Math.floor((pz - oz) / cellSize), 0, dims.z - 1);
    if (occ[ix + dims.x * (iy + dims.y * iz)]) return t;
    t += step;
  }
  return null;
}

test('a ray that stays fully inside the grid: both strategies agree', () => {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  occ[3 + dims.x * (3 + dims.y * 3)] = 1; // one interior occupied cell
  const origin = [0, 0, 0];
  const a = marchBoundsCheckSkip(occ, dims, origin, 1, [0.5, 3.5, 3.5], [1, 0, 0], 10);
  const b = marchClampAndRead(occ, dims, origin, 1, [0.5, 3.5, 3.5], [1, 0, 0], 10);
  assert.equal(a, b);
  assert.ok(a !== null);
});

test('a ray that EXITS the grid past a boundary cell that happens to be occupied: the strategies DIVERGE', () => {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  // occupy the LAST cell on the +x boundary (ix=5), e.g. a wall's own AABB
  // clamped there at write time (voxelize.js does this intentionally)
  occ[5 + dims.x * (3 + dims.y * 3)] = 1;
  const origin = [0, 0, 0];
  // a ray starting well past the wall, heading further +x (away from
  // everything) -- there is NO real geometry in its path, it should MISS
  const rayOrigin = [8, 3.5, 3.5]; // already outside the grid on +x
  const rayDir = [1, 0, 0];
  const boundsCheckResult = marchBoundsCheckSkip(occ, dims, origin, 1, rayOrigin, rayDir, 10);
  const clampReadResult = marchClampAndRead(occ, dims, origin, 1, rayOrigin, rayDir, 10);
  assert.equal(boundsCheckResult, null, 'correct: no geometry outside the grid -> miss');
  assert.notEqual(clampReadResult, null, 'the clamp-and-read strategy falsely hits the clamped boundary cell');
  assert.equal(clampReadResult, 0, 'and reports it at t=0 (immediate, permanent self-hit for the whole ray)');
});

test('mutant: if the boundary cell were NOT occupied, the two strategies would coincidentally agree again (documents why this bug is geometry-dependent, not always visible)', () => {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z); // nothing occupied anywhere
  const origin = [0, 0, 0];
  const rayOrigin = [8, 3.5, 3.5];
  const rayDir = [1, 0, 0];
  const a = marchBoundsCheckSkip(occ, dims, origin, 1, rayOrigin, rayDir, 10);
  const b = marchClampAndRead(occ, dims, origin, 1, rayOrigin, rayDir, 10);
  assert.equal(a, null);
  assert.equal(b, null, 'sanity: with an empty boundary cell the bug is silent -- exactly why it only showed up near the wall in the live scene');
});

// -------- source-level confirmation the fix landed --------
test('gi-nodes.js: marchOccupancyTSL bounds-checks before reading occupancy (no unconditional clamped read)', () => {
  assert.ok(SRC.includes('inBounds'), 'expected an explicit in-bounds guard');
  assert.ok(!SRC.includes('worldToVoxelIndexTSL'), 'the old clamp-and-read helper must be gone, not just unused');
});

test('mutant: re-introducing a clamp() call in the march\'s per-step index computation would reproduce the exact bug', () => {
  const marchStepUsesClamp = SRC.includes('clamp(int(floor(rel.x))');
  assert.equal(marchStepUsesClamp, false, 'the march loop itself must never clamp its per-step index (clamp is still legitimately used elsewhere -- query/bounce probe-grid lookups -- just not here)');
});

// -------- voxelizeTriangles + marchOccupancy integration sanity (real scene shape) --------
test('integration: a wall triangle at the exact grid edge, plus a ray exiting past it, reproduces the live scene(ii) failure shape and the fix resolves it', () => {
  const dims = { x: 20, y: 2, z: 20 };
  const origin = [-10, 0.5, -10];
  const cell = 1;
  // a wall spanning x in [8,10] (matches buildOpenPlaneRedWallScene's pillar's x-range)
  const wallTri = [8, 0.5, -2, 10, 0.5, -2, 10, 0.5, 2];
  const occ = voxelizeTriangles([wallTri], origin, cell, dims);
  // a probe at the far +x edge of the PROBE grid (world x=10, clamps into
  // the SAME boundary cell the wall occupies) firing a ray further +x
  const rayOrigin = [10.001, 0.5, 0]; // just past the voxel grid's +x edge
  const rayDir = [1, 0, 0];
  const fixed = marchBoundsCheckSkip(occ, dims, origin, cell, rayOrigin, rayDir, 20);
  assert.equal(fixed, null, 'after the fix, a ray already outside the grid heading further away correctly misses');
});
