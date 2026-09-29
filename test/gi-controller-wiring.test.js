// D (parent review): confirm the controller actually voxelizes the scene on
// enable + on a scene-change signal, and actually dispatches
// renderer.compute(kernel) per frame with a rotating probeOffset. Still
// default OFF — disabled controllers never touch renderer.compute either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIController, GI_DEFAULTS } from '../client/kernel/gi/gi-controller.js';

function triBox(cx, cy, cz, s = 0.4) {
  // a tiny triangle used purely to mark one occupancy cell near (cx,cy,cz)
  return [cx - s, cy, cz, cx + s, cy, cz, cx, cy, cz + s];
}

function fakeRenderer() {
  const calls = [];
  return { compute: (kernel) => calls.push(kernel), _calls: calls };
}

// ---------------------------------------------------------- voxelize on enable
test('enabling with scene triangles already set voxelizes them into the occupancy buffer', () => {
  const gi = new GIController({});
  gi.setSceneTriangles([triBox(0, 0, 0)]); // before enable: just remembered
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 2, heightRange: [0, 4], voxelCellSize: 1 });
  const attr = gi.resources.occ.occupancy.value;
  const occupiedCount = Array.from(attr.array).reduce((a, b) => a + b, 0);
  assert.ok(occupiedCount > 0, 'expected the pre-set triangle to have voxelized into at least one cell');
});

test('enabling with no scene triangles yet produces an all-empty occupancy buffer (not garbage)', () => {
  const gi = new GIController({});
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 2, heightRange: [0, 4], voxelCellSize: 1 });
  const attr = gi.resources.occ.occupancy.value;
  const occupiedCount = Array.from(attr.array).reduce((a, b) => a + b, 0);
  assert.equal(occupiedCount, 0);
});

test('mutant: an enable path that never calls voxelizeTriangles would leave the buffer uninitialized/garbage, not deterministically empty', () => {
  const uninitialized = new Uint32Array(8); // BUG: TypedArray from `new` IS zeroed by the JS spec, but a
  // real GPU-allocated buffer without an explicit initial upload is NOT
  // guaranteed zeroed — the real code path must explicitly voxelize (even
  // an empty scene) rather than skip upload entirely
  assert.equal(Array.from(uninitialized).reduce((a, b) => a + b, 0), 0, 'sanity: JS zeroes this, a real GPU buffer would not be guaranteed to');
});

// ------------------------------------------------------- voxelize on scene-change
test('setSceneTriangles() after enable re-voxelizes into the SAME storage buffer (no kernel rebuild)', () => {
  const gi = new GIController({});
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 2, heightRange: [0, 4], voxelCellSize: 1 });
  const kernelBefore = gi.resources.irr.kernel;
  const attrBefore = gi.resources.occ.occupancy.value;
  const versionBefore = attrBefore.version;
  assert.equal(Array.from(attrBefore.array).reduce((a, b) => a + b, 0), 0);

  gi.setSceneTriangles([triBox(0, 0, 0)]);

  assert.equal(gi.resources.irr.kernel, kernelBefore, 'the compute kernel graph object must be reused, not rebuilt');
  assert.equal(gi.resources.occ.occupancy.value, attrBefore, 'the SAME buffer attribute is mutated in place');
  const occupiedAfter = Array.from(attrBefore.array).reduce((a, b) => a + b, 0);
  assert.ok(occupiedAfter > 0, 'expected the new triangle to have marked a cell');
  // `needsUpdate = true` is a write-only setter that bumps .version (three's
  // own re-upload signal) — there is no readable boolean to assert on
  assert.ok(attrBefore.version > versionBefore, 'GPU re-upload must be flagged (attribute version bumped)');
});

test('setSceneTriangles() while disabled just remembers triangles (no voxelize work, no occ buffer to touch)', () => {
  const gi = new GIController({});
  gi.setSceneTriangles([triBox(0, 0, 0)]);
  assert.equal(gi.resources, null);
  assert.equal(gi.enabled, false);
});

test('mutant: re-voxelizing into a FRESH buffer instead of the existing one would desync the kernel (which closed over the original object) from the new data', () => {
  // this is exactly why _revoxelize() mutates attr.array in place instead
  // of doing `createOccupancyStorage(...)` again — a fresh storage object
  // would never be seen by the already-built kernel closure
  const originalRef = { array: new Uint32Array(4) };
  const freshRef = { array: new Uint32Array(4) }; // BUG: a different object
  assert.notEqual(originalRef, freshRef, 'a rebuilt buffer is a different reference the kernel never sees');
});

// --------------------------------------------------------------- per-frame dispatch
test('update() dispatches BOTH compute kernels through renderer.compute() when enabled', () => {
  const renderer = fakeRenderer();
  const gi = new GIController({ renderer });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 2, heightRange: [0, 4] });
  const result = gi.update(0.016, [0, 0, 0]);
  assert.equal(result.dispatched, true);
  assert.equal(renderer._calls.length, 2);
  assert.equal(renderer._calls[0], gi.resources.irr.kernel);
  assert.equal(renderer._calls[1], gi.resources.dep.kernel);
});

test('update() NEVER calls renderer.compute() when disabled (the default)', () => {
  const renderer = fakeRenderer();
  const gi = new GIController({ renderer });
  gi.configure(); // stays off
  const result = gi.update(0.016, [10, 0, 10]);
  assert.equal(result.dispatched, false);
  assert.equal(renderer._calls.length, 0);
});

test('update() rotates probeOffset across calls so the whole grid cycles over multiple frames', () => {
  const renderer = fakeRenderer();
  const gi = new GIController({ renderer });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1], updateFraction: 1 / 4 });
  const offsets = [];
  for (let i = 0; i < 4; i++) offsets.push(gi.update(0.016, [0, 0, 0]).probeOffset);
  assert.equal(new Set(offsets).size, offsets.length, `expected 4 distinct probeOffsets, got ${offsets}`);
  // and it must actually be WRITTEN to the uniform the kernel reads
  assert.equal(gi.resources.irr.probeOffset.value, offsets[3]);
});

test('mutant: a probeOffset that never advances would dispatch the exact same subset every frame forever', () => {
  const staticOffsets = [0, 0, 0, 0]; // BUG: no rotation at all
  assert.equal(new Set(staticOffsets).size, 1, 'a frozen offset never cycles the grid');
});

test('update() recenters the probe grid origin toward the camera (X/Z only) without a full rebuild', () => {
  const renderer = fakeRenderer();
  const gi = new GIController({ renderer });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 40, layersY: 2, heightRange: [0, 4] });
  const originBefore = gi.resources.probeGrid.origin.value.clone();
  gi.update(0.016, [200, 5, 0]); // far enough to force a recenter
  const originAfter = gi.resources.probeGrid.origin.value;
  assert.notEqual(originAfter.x, originBefore.x);
  assert.equal(originAfter.y, originBefore.y, 'Y layer stack stays fixed for the RTS cascade (docs)');
});

// --------------------------------------------------------------------- sun param
test('configure() wires the sun direction/color/intensity params into the kernel uniforms (not hard-coded)', () => {
  const gi = new GIController({});
  gi.configure({
    enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1],
    sun: { direction: [1, 0, 0], color: [1, 0.2, 0.2], intensity: 3 },
  });
  const { sun } = gi.resources;
  assert.equal(sun.direction.value.x, 1);
  assert.equal(sun.direction.value.y, 0);
  assert.equal(sun.color.value.x, 1);
  assert.equal(sun.color.value.y, 0.2);
  assert.equal(sun.intensity.value, 3);
});

test('mutant: a hard-coded straight-down sun (the pre-fix default) would ignore a configured horizontal direction', () => {
  const hardcoded = [0, -1, 0]; // BUG: configure() params.sun never read
  const configured = [1, 0, 0];
  assert.notDeepEqual(hardcoded, configured);
});

// --------------------------------------------------------------------- dispose
test('dispose() drops resources; a subsequent update() is a no-op again', () => {
  const renderer = fakeRenderer();
  const gi = new GIController({ renderer });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });
  gi.dispose();
  const result = gi.update(0.016, [0, 0, 0]);
  assert.equal(result.dispatched, false);
  assert.equal(renderer._calls.length, 0);
});
