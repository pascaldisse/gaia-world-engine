import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voxelizeTriangles, marchOccupancy } from '../client/kernel/gi/voxelize.js';

const dims = { x: 4, y: 4, z: 4 };
const origin = [0, 0, 0];
const cell = 1;

test('a triangle marks only voxels its AABB overlaps', () => {
  // triangle fully inside voxel (0,0,0)..(1,1,1)
  const tri = [0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.2, 0.1];
  const occ = voxelizeTriangles([tri], origin, cell, dims);
  assert.equal(occ[0 + dims.x * (0 + dims.y * 0)], 1);
  // a far corner voxel must stay empty
  assert.equal(occ[3 + dims.x * (3 + dims.y * 3)], 0);
  assert.equal(occ.reduce((a, b) => a + b, 0), 1);
});

test('a triangle spanning several voxels marks its whole AABB range', () => {
  const tri = [0.5, 0.5, 0.5, 2.5, 0.5, 0.5, 0.5, 2.5, 0.5];
  const occ = voxelizeTriangles([tri], origin, cell, dims);
  // AABB x:[0.5,2.5] -> voxels 0,1,2 ; y:[0.5,2.5] -> 0,1,2 ; z:0
  for (let iy = 0; iy <= 2; iy++)
    for (let ix = 0; ix <= 2; ix++)
      assert.equal(occ[ix + dims.x * (iy + dims.y * 0)], 1, `(${ix},${iy},0) should be occupied`);
  assert.equal(occ[3 + dims.x * (3 + dims.y * 0)], 0);
});

test('a triangle fully outside the grid leaves it empty (no crash, no wraparound)', () => {
  const tri = [100, 100, 100, 101, 100, 100, 100, 101, 100];
  const occ = voxelizeTriangles([tri], origin, cell, dims);
  assert.equal(occ.reduce((a, b) => a + b, 0), 0);
});

test('marchOccupancy returns null through empty space and a distance on first hit', () => {
  const occ = voxelizeTriangles([[2.1, 2.1, 2.1, 2.2, 2.1, 2.1, 2.1, 2.2, 2.1]], origin, cell, dims);
  const miss = marchOccupancy(occ, dims, origin, cell, [0, 0.5, 0.5], [1, 0, 0], 1);
  assert.equal(miss, null); // stops short of the occupied voxel at x~2
  const hit = marchOccupancy(occ, dims, origin, cell, [0, 2.15, 2.15], [1, 0, 0], 10);
  assert.ok(hit !== null && hit > 0);
});

// mutation check: clamping the AABB range WITHOUT first testing whether the
// range is fully outside the grid (the exact bug this file's real skip-check
// was written to fix) collapses an out-of-range triangle onto a false edge
// voxel instead of leaving the grid untouched.
test('mutant: clamp-without-skip-check falsely marks a voxel for fully-outside geometry', () => {
  function clampNoSkipCheck(triangles, originW, cellSize, d) {
    const occArr = new Uint8Array(d.x * d.y * d.z);
    const clampV = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    for (const tri of triangles) {
      let ix0 = Math.floor((tri[0] - originW[0]) / cellSize);
      let ix1 = Math.floor((tri[3] - originW[0]) / cellSize);
      let iy0 = Math.floor((tri[1] - originW[1]) / cellSize);
      let iy1 = Math.floor((tri[4] - originW[1]) / cellSize);
      let iz0 = Math.floor((tri[2] - originW[2]) / cellSize);
      let iz1 = Math.floor((tri[5] - originW[2]) / cellSize);
      // BUG: clamps straight away, no "fully outside" skip first
      ix0 = clampV(ix0, 0, d.x - 1); ix1 = clampV(ix1, 0, d.x - 1);
      iy0 = clampV(iy0, 0, d.y - 1); iy1 = clampV(iy1, 0, d.y - 1);
      iz0 = clampV(iz0, 0, d.z - 1); iz1 = clampV(iz1, 0, d.z - 1);
      for (let iz = iz0; iz <= iz1; iz++)
        for (let iy = iy0; iy <= iy1; iy++)
          for (let ix = ix0; ix <= ix1; ix++)
            occArr[ix + d.x * (iy + d.y * iz)] = 1;
    }
    return occArr;
  }
  const farTri = [100, 100, 100, 101, 100, 100, 100, 101, 100]; // same as the 'fully outside' test above
  const good = voxelizeTriangles([farTri], origin, cell, dims);
  const bad = clampNoSkipCheck([farTri], origin, cell, dims);
  assert.equal(good.reduce((a, b) => a + b, 0), 0, 'real function: nothing marked');
  assert.ok(bad.reduce((a, b) => a + b, 0) > 0, 'mutant: falsely marks the clamped edge voxel');
});
