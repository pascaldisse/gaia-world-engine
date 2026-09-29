// Builds the GI graph against REAL three r180 (three/webgpu + three/tsl) —
// node has no GPU, so these tests assert graph CONSTRUCTION only: node
// types, dispatch shape math, and the IrradianceNode wiring. Whether the
// compute kernel/material actually shades correctly needs a real GPU frame
// (see docs/GI-PROBES.md UNVERIFIED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniform, vec3, float } from 'three/tsl';
import {
  createProbeAtlases,
  createGIUpdateKernel,
  createGIQueryNode,
  wrapAsIrradianceNode,
} from '../client/kernel/gi/gi-nodes.js';

test('createProbeAtlases sizes storage buffers from probeCount x atlas resolution', () => {
  const atlases = createProbeAtlases({ probeCount: 100, irradianceRes: 8, depthRes: 16 });
  assert.equal(atlases.irradiance.isStorageBufferNode ?? atlases.irradiance.isNode, true);
  assert.equal(atlases.depth.isNode, true);
  assert.equal(atlases.probeCount, 100);
});

test('createGIUpdateKernel produces a real ComputeNode sized to probeCount x irradianceRes^2', () => {
  const atlases = createProbeAtlases({ probeCount: 50, irradianceRes: 8, depthRes: 16 });
  const { kernel, totalTexels } = createGIUpdateKernel({
    atlases,
    raysPerProbe: 64,
    occupancyTexture: null,
    hysteresis: { irradianceAlpha: 0.97 },
  });
  assert.equal(totalTexels, 50 * 8 * 8);
  assert.equal(kernel.isComputeNode, true);
  assert.equal(kernel.count, totalTexels);
});

test('createGIUpdateKernel dispatch shape scales linearly with probeCount (no fixed-size assumption)', () => {
  const a1 = createProbeAtlases({ probeCount: 10, irradianceRes: 8, depthRes: 16 });
  const a2 = createProbeAtlases({ probeCount: 20, irradianceRes: 8, depthRes: 16 });
  const k1 = createGIUpdateKernel({ atlases: a1, raysPerProbe: 32, hysteresis: {} });
  const k2 = createGIUpdateKernel({ atlases: a2, raysPerProbe: 32, hysteresis: {} });
  assert.equal(k2.totalTexels, k1.totalTexels * 2);
});

test('createGIQueryNode returns a real TSL node (constructable with world position + normal inputs)', () => {
  const atlases = createProbeAtlases({ probeCount: 27, irradianceRes: 8, depthRes: 16 });
  const gridUniforms = { origin: vec3(0, 0, 0), spacing: float(8), dims: uniform(3) };
  const node = createGIQueryNode({
    atlases,
    worldPositionNode: vec3(1, 2, 3),
    normalNode: vec3(0, 1, 0),
    gridUniforms,
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
  const atlases = createProbeAtlases({ probeCount: 12, irradianceRes: 4, depthRes: 16 }); // non-default res
  const { totalTexels } = createGIUpdateKernel({ atlases, raysPerProbe: 16, hysteresis: {} });
  const hardcodedMutant = 12 * 8 * 8; // BUG: assumes irradianceRes=8 always
  assert.notEqual(totalTexels, hardcodedMutant);
  assert.equal(totalTexels, 12 * 4 * 4);
});
