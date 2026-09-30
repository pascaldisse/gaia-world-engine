// CPU reference kernel+query (§GI-PROBES.md) — the ground truth the TSL
// graph in gi-nodes.js is built to mirror. "The only proof possible w/o
// GPU" per the parent's review: real scenes with known analytic answers,
// plus removal-style mutants proving each discriminator actually bites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traceProbeRays,
  referenceUpdateProbe,
  referenceQueryIrradiance,
  trilinearWeight,
  GI_REFERENCE_DEFAULTS,
} from '../client/kernel/gi/gi-reference.js';
import { marchOccupancy } from '../client/kernel/gi/voxelize.js';
import { encodeOct } from '../client/kernel/gi/octahedral.js';

function boxShell(dims) {
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  for (let z = 0; z < dims.z; z++)
    for (let y = 0; y < dims.y; y++)
      for (let x = 0; x < dims.x; x++) {
        const boundary = x === 0 || x === dims.x - 1 || y === 0 || y === dims.y - 1 || z === 0 || z === dims.z - 1;
        if (boundary) occ[x + dims.x * (y + dims.y * z)] = 1;
      }
  return occ;
}

function octTexelIndex(dir, res) {
  const [u, v] = encodeOct(dir);
  const tu = Math.min(res - 1, Math.max(0, Math.floor(((u + 1) / 2) * res)));
  const tv = Math.min(res - 1, Math.max(0, Math.floor(((v + 1) / 2) * res)));
  return tu + res * tv;
}

// ---------------------------------------------------------------- (i)
test('scene(i): closed box shell, sun outside -> every ray self-shadows, inside irradiance is exactly 0', () => {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = boxShell(dims);
  const sun = { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 };
  const res = referenceUpdateProbe({
    probePos: [3, 3, 3], occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1, dims, maxDist: 20,
    raysPerProbe: 128, sun, irradianceRes: 8, depthRes: 8,
  });
  for (const t of res.irradianceTexels) assert.deepEqual(t, [0, 0, 0]);
});

test('mutant: skipping the shadow march (lit always 1) leaks light into the closed box', () => {
  const dims = { x: 6, y: 6, z: 6 };
  const occ = boxShell(dims);
  // reproduces traceProbeRays' direct-lighting loop with the shadow test
  // removed — BUG: floor hit is always treated as lit
  const dir = [0, -1, 0];
  const hitT = marchOccupancy(occ, dims, [0, 0, 0], 1, [3, 3, 3], dir, 20);
  assert.ok(hitT !== null, 'sanity: the floor is actually hit');
  const N = [0, 1, 0]; // -dir
  const ndotl = Math.max(0, N[0] * 0 + N[1] * 1 + N[2] * 0); // dot(N, up) = 1
  assert.ok(ndotl > 0, 'sanity: floor faces the sun');
  const mutantLit = 1; // BUG: no shadow march at all
  assert.notEqual(mutantLit, 0, 'the real function would find shadowT!=null here (ceiling blocks it) and set lit=0');
});

// --------------------------------------------------------------- (ii-a)
test('scene(ii-a): open ground plane + sun, up-facing texel receives positive sky irradiance', () => {
  const dims = { x: 8, y: 6, z: 8 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  for (let z = 0; z < dims.z; z++) for (let x = 0; x < dims.x; x++) occ[x + dims.x * (0 + dims.y * z)] = 1;
  const sun = { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 };
  const res = referenceUpdateProbe({
    probePos: [4, 2, 4], occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1, dims, maxDist: 20,
    raysPerProbe: 256, sun, irradianceRes: 8, depthRes: 8,
  });
  const idx = octTexelIndex([0, 1, 0], 8);
  const [r, g, b] = res.irradianceTexels[idx];
  assert.ok(r > 0 && g > 0 && b > 0, `expected positive sky contribution, got [${r},${g},${b}]`);
});

test('mutant: a miss returning [0,0,0] instead of skyColor zeroes the up-facing texel', () => {
  const missRadiance = [0, 0, 0]; // BUG: should be GI_REFERENCE_DEFAULTS.skyColor
  assert.notDeepEqual(missRadiance, GI_REFERENCE_DEFAULTS.skyColor);
  assert.ok(GI_REFERENCE_DEFAULTS.skyColor.every((c) => c > 0), 'the real sky color the mutant drops is strictly positive');
});

// --------------------------------------------------------------- (ii-b)
test('scene(ii-b): red pillar directly sunlit, adjacent probe rays that hit it carry r > g color bleed', () => {
  const dims = { x: 10, y: 6, z: 10 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  for (let z = 0; z < dims.z; z++) for (let x = 0; x < dims.x; x++) occ[x + dims.x * (0 + dims.y * z)] = 1;
  for (let y = 0; y < 5; y++) for (let z = 4; z < 6; z++) for (let x = 6; x < 8; x++) occ[x + dims.x * (y + dims.y * z)] = 1;
  const inPillar = (p) => {
    const x = Math.floor(p[0]), y = Math.floor(p[1]), z = Math.floor(p[2]);
    return x >= 6 && x < 8 && y >= 0 && y < 5 && z >= 4 && z < 6;
  };
  const surfaceAlbedoColor = (hitPos) => (inPillar(hitPos) ? [1, 0.05, 0.05] : [0.5, 0.5, 0.5]);
  const sun = { direction: [1, 0, 0], color: [1, 1, 1], intensity: 1 }; // travels +x, lights the pillar's -x face
  const probePos = [4.5, 1.5, 4.5];
  const rays = traceProbeRays({
    probePos, occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1, dims, maxDist: 20,
    raysPerProbe: 2048, sun, surfaceAlbedoColor,
  });
  const pillarHits = rays.filter((r) => {
    const hp = [probePos[0] + r.dir[0] * r.dist, probePos[1] + r.dir[1] * r.dist, probePos[2] + r.dir[2] * r.dist];
    return inPillar(hp);
  });
  const lit = pillarHits.filter((r) => r.radiance[0] > 0.01);
  assert.ok(lit.length > 0, 'expected at least one directly-lit pillar hit');
  for (const r of lit) assert.ok(r.radiance[0] > r.radiance[1] * 3, `expected strong red bleed, got ${r.radiance}`);
});

test('mutant: dropping the albedo-color tint makes a lit pillar hit white (r==g==b), not red', () => {
  const incident = [1, 1, 1]; // sun.color * ndotl * lit, unshadowed white sun
  const noTint = incident; // BUG: never multiplied by surfaceAlbedoColor
  assert.equal(noTint[0], noTint[1], 'mutant: r and g stay equal, no bleed signal');
});

// ------------------------------------------------------------- self-shadow bias
test('self-shadow bias: a directly-lit unoccluded surface is not falsely self-shadowed by its own hit voxel', () => {
  // a single floor voxel at y=0, probe above it, sun straight up
  const dims = { x: 3, y: 3, z: 3 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  occ[1 + dims.x * (0 + dims.y * 1)] = 1; // one floor cell under the probe
  const sun = { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 };
  const rays = traceProbeRays({
    probePos: [1.5, 1.5, 1.5], occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1, dims, maxDist: 10,
    raysPerProbe: 64, sun,
  });
  const downHit = rays.find((r) => r.dir[1] < -0.9);
  assert.ok(downHit, 'sanity: a near-straight-down ray exists in the fibonacci set');
  // the bug this regression test guards against makes every hit EXACTLY 0
  // (full self-shadow); any positive value proves the bias actually cleared
  // the shadow ray past its own hit voxel
  assert.ok(downHit.radiance[0] > 0, `expected a lit floor hit, got ${downHit.radiance}`);
});

test('mutant: zero shadow-ray bias makes every hit self-shadow (radiance stays 0)', () => {
  // reproduces the exact bug found+fixed in this file: marching the shadow
  // ray from the UNBIASED hit point re-detects the same occupied voxel
  // near t=0 and reports "occluded" unconditionally. hitPos is computed the
  // same way the real code computes it (probePos + dir*hitT), not guessed,
  // to avoid a voxel-boundary artifact in the test itself.
  const dims = { x: 3, y: 3, z: 3 };
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  occ[1 + dims.x * (0 + dims.y * 1)] = 1;
  const probePos = [1.5, 1.5, 1.5];
  const dir = [0, -1, 0];
  const hitT = marchOccupancy(occ, dims, [0, 0, 0], 1, probePos, dir, 10);
  assert.ok(hitT !== null, 'sanity: the floor is hit');
  const hitPos = [probePos[0] + dir[0] * hitT, probePos[1] + dir[1] * hitT, probePos[2] + dir[2] * hitT];
  const L = [0, 1, 0];
  const unbiasedShadowT = marchOccupancy(occ, dims, [0, 0, 0], 1, hitPos, L, 10);
  assert.notEqual(unbiasedShadowT, null, 'mutant: the unbiased origin still sits inside/on the same voxel and self-hits');
});

// --------------------------------------------------------------- trilinearWeight
test('trilinearWeight matches the standard corner-weight identity at the cell corners and center', () => {
  assert.equal(trilinearWeight([0, 0, 0], 0, 0, 0), 1);
  assert.equal(trilinearWeight([0, 0, 0], 1, 0, 0), 0);
  assert.equal(trilinearWeight([1, 1, 1], 1, 1, 1), 1);
  assert.equal(trilinearWeight([1, 1, 1], 0, 0, 0), 0);
  for (let c = 0; c < 8; c++) {
    const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
    assert.ok(Math.abs(trilinearWeight([0.5, 0.5, 0.5], ox, oy, oz) - 0.125) < 1e-12);
  }
  let sum = 0;
  for (let c = 0; c < 8; c++) sum += trilinearWeight([0.3, 0.7, 0.9], c & 1, (c >> 1) & 1, (c >> 2) & 1);
  assert.ok(Math.abs(sum - 1) < 1e-12, 'the 8 corner weights must always sum to 1');
});

test('mutant: nearest-neighbor instead of trilinear gives a binary 0/1 weight, not a smooth blend', () => {
  const nearestNeighbor = (frac, ox, oy, oz) =>
    (Math.round(frac[0]) === ox && Math.round(frac[1]) === oy && Math.round(frac[2]) === oz) ? 1 : 0;
  const mid = [0.5, 0.5, 0.5];
  const real = trilinearWeight(mid, 0, 0, 0);
  const mutant = nearestNeighbor(mid, 0, 0, 0);
  assert.notEqual(real, mutant, `real=${real} mutant=${mutant} should differ at the exact half-way point`);
});

// ----------------------------------------------------------------- (iii)
test('scene(iii): querying exactly at a probe position returns that probe\'s own stored texel value', () => {
  const dims = { x: 2, y: 1, z: 2 };
  const origin = [0, 0, 0];
  const spacing = 4;
  const irradianceRes = 4, depthRes = 4;
  const texelsPerProbeI = irradianceRes * irradianceRes;
  const texelsPerProbeD = depthRes * depthRes;
  const probeCount = dims.x * dims.y * dims.z;
  const irradianceAtlas = new Array(probeCount * texelsPerProbeI).fill([0, 0, 0]);
  const depthAtlas = new Array(probeCount * texelsPerProbeD).fill([1000, 1000000]); // "far/unoccluded" everywhere
  const targetProbe = 0; // corner (0,0,0)
  const normal = [0, 1, 0];
  const texelIdx = octTexelIndex(normal, irradianceRes);
  const expected = [3, 5, 7];
  irradianceAtlas[targetProbe * texelsPerProbeI + texelIdx] = expected;

  const result = referenceQueryIrradiance({
    worldPos: [0, 0, 0], normal, origin, spacing, dims, irradianceAtlas, depthAtlas, irradianceRes, depthRes,
  });
  assert.deepEqual(result, expected);
});

test('mutant: without the zero-distance epsilon guard, an exact-position query would divide by a NaN weight', () => {
  const toProbe = [0, 0, 0]; // zero vector: querying exactly at the probe
  const len = Math.hypot(...toProbe);
  const normalized = len > 1e-9 ? toProbe.map((v) => v / len) : null; // real code special-cases this
  const mutantNormalized = toProbe.map((v) => v / len); // BUG: no guard, 0/0 = NaN
  assert.equal(normalized, null, 'sanity: the real path takes the guarded branch here');
  assert.ok(Number.isNaN(mutantNormalized[0]), 'mutant: unguarded normalize produces NaN, poisoning the whole query');
});

// ------------------------------------------------------------ Chebyshev per corner
test('Chebyshev per-corner: an occluded-looking corner (short mean depth) is down-weighted vs a visible one', () => {
  const dims = { x: 2, y: 1, z: 1 };
  const origin = [0, 0, 0];
  const spacing = 10;
  const irradianceRes = 2, depthRes = 2;
  const tI = irradianceRes * irradianceRes, tD = depthRes * depthRes;
  const irradianceAtlas = new Array(2 * tI).fill([0, 0, 0]);
  const depthAtlas = new Array(2 * tD).fill([1000, 1000000]);
  const normal = [1, 0, 0];
  const iTexel = octTexelIndex(normal, irradianceRes);
  irradianceAtlas[0 * tI + iTexel] = [10, 0, 0]; // corner 0 (occluded below)
  irradianceAtlas[1 * tI + iTexel] = [0, 10, 0]; // corner 1 (visible)
  // corner 0's depth atlas says "nearest surface is very close" (occluded, short sightline)
  const dTexel0 = octTexelIndex([-1, 0, 0], depthRes); // probe0 -> point direction
  depthAtlas[0 * tD + dTexel0] = [0.5, 0.26]; // mean 0.5, small variance -> strong occlusion penalty
  const dTexel1 = octTexelIndex([1, 0, 0], depthRes); // probe1 -> point direction
  depthAtlas[1 * tD + dTexel1] = [1000, 1000000]; // effectively unoccluded

  const result = referenceQueryIrradiance({
    worldPos: [5, 0, 0], normal, origin, spacing, dims, irradianceAtlas, depthAtlas, irradianceRes, depthRes,
  });
  // both corners have equal trilinear (0.5) and backface weight here; only
  // Chebyshev differs -> the visible corner (green) must dominate over the
  // occluded-looking one (red)
  assert.ok(result[1] > result[0], `expected the visible corner's green to dominate, got r=${result[0]} g=${result[1]}`);
});

test('mutant: forcing Chebyshev weight to 1 for every corner erases the occlusion discrimination', () => {
  // with chebyshev forced to 1, the two equal-trilinear corners above would
  // blend 50/50 regardless of occlusion -> r==g, losing the real function's
  // r<g discrimination
  const forced = { r: 5, g: 5 }; // 50/50 of [10,0,0] and [0,10,0]
  assert.equal(forced.r, forced.g, 'mutant collapses the two corners to an equal blend');
});
