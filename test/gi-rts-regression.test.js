// RTS mode must stay BIT-IDENTICAL after the v2 open-world work (L-GI).
// (1) source sha256 of every RTS-path module pinned (no byte changed);
// (2) numeric pin: referenceUpdateProbe on a fixed scene hashes to the pre-v2 value;
// (3) defaults untouched: GI_DEFAULTS minus the new `mode` key == pre-v2 literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { referenceUpdateProbe } from '../client/kernel/gi/gi-reference.js';
import { GI_DEFAULTS } from '../client/kernel/gi/gi-controller.js';
const sha = (f) => createHash('sha256').update(readFileSync(new URL(`../client/kernel/gi/${f}`, import.meta.url))).digest('hex');
const PINS = {
  'gi-nodes.js': 'aa4195ecabd5b3080cf40596b2d4b665990b248fcb55f5bbc277738d7baca4bc',
  'voxelize.js': '5dbcdbf9d8e9524adcc23dc79d0cc89a748194b705e23a49769ddfb5d93632ba',
  'probe-grid.js': '6a1f6e3463d5af745cd373879e66dab2375e9b53fff48b5f4a76b0989cc68a83',
  'irradiance.js': '04c6b1cc0440e05849f53c8ebc87d3ad6b2318b0092b097ff24f51e7cc3a7adb', // re-pinned 10-05 c957276: dropped dead const-reassign line (TypeError when rotation set); RTS numeric pin below unchanged
  'octahedral.js': '7cf2b158ded68882a0ef810ead7800a5ddf2e951c118986d1981dc05c7d0b793',
  'chebyshev.js': '321f1586a49527549dd012bd373d7e821d6c1f2a6f74da9cd5eb37d2997e8467',
};
for (const [f, h] of Object.entries(PINS)) test(`RTS path unchanged: ${f} byte-identical to pre-v2`, () => assert.equal(sha(f), h));
test('RTS numeric pin: referenceUpdateProbe fixed scene == pre-v2 hash', () => {
  const dims = { x: 8, y: 6, z: 8 }; const occ = new Uint8Array(8 * 6 * 8);
  for (let z = 0; z < 8; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) if (x === 6 && y < 4) occ[x + 8 * (y + 6 * z)] = 1;
  const r = referenceUpdateProbe({ probePos: [2, 2, 3], occupancy: occ, voxelOrigin: [0, 0, 0], cellSize: 1, dims, maxDist: 20, raysPerProbe: 32, sun: { direction: [-1, -0.5, 0.2], color: [1, 1, 1], intensity: 1 }, albedo: 0.5, irradianceRes: 8, depthRes: 16 });
  assert.equal(createHash('sha256').update(JSON.stringify(r)).digest('hex'), '5988391b2d74b3128854d93dd011e4d403bd56fe1d586c1cd22c01a73a20a09e');
});
test('RTS defaults: every pre-v2 GI_DEFAULTS key/value unchanged, default mode is rts', () => {
  const { mode, ...rest } = GI_DEFAULTS;
  assert.equal(mode, 'rts');
  assert.deepEqual(rest, { enabled: false, spacing: 8, halfExtentXZ: 40, layersY: 3, heightRange: [0, 12], raysPerProbe: 64, updateFraction: 1 / 8, irradianceRes: 8, depthRes: 16, irradianceAlpha: 0.97, depthAlpha: 0.9, voxelCellSize: 1, voxelMaxDist: 64, albedo: 0.5, skyColor: [0.4, 0.5, 0.7], maxPointLights: 16, sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 } });
});
