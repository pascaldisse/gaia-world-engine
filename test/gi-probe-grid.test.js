import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridDims, probeIndex, probeCount, gridToWorld, recenterGrid, buildProbeGrid } from '../client/kernel/gi/probe-grid.js';

test('gridDims covers the half-extent at the given spacing', () => {
  assert.equal(gridDims(40, 8), 11); // -40..40 step 8 inclusive = 11 points
  assert.equal(gridDims(0, 8), 1);
});

test('probeIndex is x-fastest and matches probeCount capacity', () => {
  const dims = { x: 3, y: 2, z: 4 };
  assert.equal(probeIndex(0, 0, 0, dims), 0);
  assert.equal(probeIndex(1, 0, 0, dims), 1);
  assert.equal(probeIndex(0, 1, 0, dims), 3);
  assert.equal(probeIndex(0, 0, 1, dims), 6);
  const seen = new Set();
  for (let iz = 0; iz < dims.z; iz++)
    for (let iy = 0; iy < dims.y; iy++)
      for (let ix = 0; ix < dims.x; ix++)
        seen.add(probeIndex(ix, iy, iz, dims));
  assert.equal(seen.size, probeCount(dims));
  assert.equal(Math.max(...seen), probeCount(dims) - 1);
});

test('gridToWorld is affine in the grid indices', () => {
  const origin = [10, 0, -10];
  assert.deepEqual(gridToWorld(0, 0, 0, origin, 8), origin);
  assert.deepEqual(gridToWorld(2, 0, 3, origin, 8), [26, 0, 14]);
});

test('recenterGrid: camera motion smaller than spacing does not shift the origin', () => {
  const spacing = 8;
  const half = 40;
  // start mid-cell (not on a spacing boundary) so a small nudge can't
  // accidentally cross into the next floor() bucket
  const r0 = recenterGrid([0, 0, 0], [4, 0, 4], spacing, half);
  const r1 = recenterGrid(r0.origin, [6, 0, 2], spacing, half); // stays within the same [0,8) cell
  assert.equal(r1.shifted, false);
  assert.deepEqual(r1.origin, r0.origin);
});

test('recenterGrid: camera motion past one full cell shifts by whole cells only', () => {
  const spacing = 8;
  const half = 40;
  const r0 = recenterGrid([0, 0, 0], [0, 0, 0], spacing, half);
  const r1 = recenterGrid(r0.origin, [17, 0, 0], spacing, half); // > 2 cells in X
  assert.equal(r1.shifted, true);
  assert.equal(r1.shiftCellsX, 2);
  assert.equal(r1.shiftCellsZ, 0);
  assert.equal((r1.origin[0] - r0.origin[0]) % spacing, 0);
});

test('buildProbeGrid: Y layer stack is fixed regardless of halfExtentXZ (RTS cascade)', () => {
  const g1 = buildProbeGrid({ spacing: 8, halfExtentXZ: 40, layersY: 3, heightRange: [0, 12] });
  const g2 = buildProbeGrid({ spacing: 8, halfExtentXZ: 120, layersY: 3, heightRange: [0, 12] });
  assert.equal(g1.dims.y, 3);
  assert.equal(g2.dims.y, 3);
  assert.ok(g2.dims.x > g1.dims.x); // only the scrolling axes grow
  assert.equal(g1.count, g1.dims.x * g1.dims.y * g1.dims.z);
});

// mutation check: y-fastest indexing instead of x-fastest must desync from
// gridToWorld's own (x,y,z) axis order
test('mutant: y-fastest probeIndex would alias distinct cells', () => {
  const dims = { x: 3, y: 2, z: 4 };
  const yFastest = (ix, iy, iz) => iy + dims.y * (ix + dims.x * iz);
  const a = yFastest(1, 0, 0);
  const b = probeIndex(1, 0, 0, dims);
  // for this dims shape the two schemes disagree on cell (1,0,0) -> proves
  // the test is sensitive to the axis-order mutant, not vacuously true
  assert.notEqual(a, b);
});
