// Builds the GI graph against REAL three r180 (three/webgpu + three/tsl) —
// node has no GPU, so these tests assert graph CONSTRUCTION and dispatch
// SHAPE only. See test/gi-nodes-parity.test.js for the source-level
// structural-op parity checks against gi-reference.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniform, vec3 } from 'three/tsl';
import {
  createOccupancyStorage,
  createProbeAtlases,
  createPointLightPool,
  createGIUpdateKernel,
  createGIDepthUpdateKernel,
  createGIQueryNode,
  wrapAsIrradianceNode,
} from '../client/kernel/gi/gi-nodes.js';

function makeFixture({ dims = { x: 4, y: 2, z: 4 }, probeCount = 8, irradianceRes = 4, depthRes = 4 } = {}) {
  const occArr = new Uint8Array(dims.x * dims.y * dims.z);
  const occ = createOccupancyStorage(occArr, dims, [0, 0, 0], 1);
  const atlases = createProbeAtlases({ probeCount, irradianceRes, depthRes });
  const lights = createPointLightPool(4);
  const sun = { direction: uniform(vec3(0, -1, 0)), color: uniform(vec3(1, 1, 1)), intensity: uniform(1) };
  const probeGrid = { origin: uniform(vec3(0, 0, 0)), spacing: 2, dims: { x: 2, y: 2, z: 2 } };
  return { occ, atlases, lights, sun, probeGrid };
}

test('createOccupancyStorage uploads a real StorageBufferNode sized to dims', () => {
  const dims = { x: 4, y: 2, z: 4 };
  const occ = createOccupancyStorage(new Uint8Array(dims.x * dims.y * dims.z), dims, [1, 2, 3], 0.5);
  assert.equal(occ.occupancy.isNode, true);
  assert.equal(occ.count, 32);
  assert.equal(occ.cellSize, 0.5);
  assert.equal(occ.voxelOrigin.isNode, true);
});

test('createProbeAtlases sizes storage buffers from probeCount x atlas resolution', () => {
  const atlases = createProbeAtlases({ probeCount: 100, irradianceRes: 8, depthRes: 16 });
  assert.equal(atlases.irradiance.isNode, true);
  assert.equal(atlases.depth.isNode, true);
  assert.equal(atlases.probeCount, 100);
});

test('createGIUpdateKernel produces a real ComputeNode sized to probeCount x irradianceRes^2', () => {
  const f = makeFixture({ probeCount: 50, irradianceRes: 8, depthRes: 16 });
  const { kernel, totalTexels } = createGIUpdateKernel({ ...f, raysPerProbe: 64, hysteresis: { irradianceAlpha: 0.97 } });
  assert.equal(totalTexels, 50 * 8 * 8);
  assert.equal(kernel.isComputeNode, true);
  assert.equal(kernel.count, totalTexels);
});

test('createGIDepthUpdateKernel produces a real ComputeNode sized to probeCount x depthRes^2', () => {
  const f = makeFixture({ probeCount: 50, irradianceRes: 8, depthRes: 16 });
  const { kernel, totalTexels } = createGIDepthUpdateKernel({ ...f, raysPerProbe: 32, hysteresis: { depthAlpha: 0.9 } });
  assert.equal(totalTexels, 50 * 16 * 16);
  assert.equal(kernel.isComputeNode, true);
});

test('createGIUpdateKernel dispatch shape scales linearly with probeCount (no fixed-size assumption)', () => {
  const f1 = makeFixture({ probeCount: 10, irradianceRes: 8, depthRes: 16 });
  const f2 = makeFixture({ probeCount: 20, irradianceRes: 8, depthRes: 16 });
  const k1 = createGIUpdateKernel({ ...f1, raysPerProbe: 32, hysteresis: {} });
  const k2 = createGIUpdateKernel({ ...f2, raysPerProbe: 32, hysteresis: {} });
  assert.equal(k2.totalTexels, k1.totalTexels * 2);
});

test('createGIQueryNode returns a real TSL node (constructable with world position + normal inputs)', () => {
  const f = makeFixture({ probeCount: 27, irradianceRes: 8, depthRes: 16 });
  const node = createGIQueryNode({
    atlases: f.atlases,
    worldPositionNode: vec3(1, 2, 3),
    normalNode: vec3(0, 1, 0),
    probeGrid: f.probeGrid,
  });
  assert.equal(node.isNode, true);
});

test('wrapAsIrradianceNode returns a real three IrradianceNode (isLightingNode) feeding indirectDiffuse', () => {
  const gi = vec3(0.1, 0.1, 0.1);
  const wrapped = wrapAsIrradianceNode(gi);
  assert.equal(wrapped.isLightingNode, true);
  assert.equal(wrapped.node, gi);
});

// removal-style mutation check: hard-coding the atlas resolution instead of
// reading it from `atlases` would desync totalTexels from createProbeAtlases
test('mutant: hard-coded irradianceRes desyncs totalTexels from the actual atlas size', () => {
  const f = makeFixture({ probeCount: 12, irradianceRes: 4, depthRes: 16 }); // non-default res
  const { totalTexels } = createGIUpdateKernel({ ...f, raysPerProbe: 16, hysteresis: {} });
  const hardcodedMutant = 12 * 8 * 8; // BUG: assumes irradianceRes=8 always
  assert.notEqual(totalTexels, hardcodedMutant);
  assert.equal(totalTexels, 12 * 4 * 4);
});
