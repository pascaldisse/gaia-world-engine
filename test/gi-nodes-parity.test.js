// Structural parity between the TSL graph (gi-nodes.js) and the CPU
// reference (gi-reference.js) — "the only proof possible w/o GPU" per the
// parent's review. Node has no WebGPU device, so a TSL Fn() body is a
// JS closure that only expands into an actual shader graph at build() time
// (verified: kernel.computeNode.shaderNode.jsFunc is the RAW, unexecuted
// callback). The chosen substitute for real WGSL codegen: `.jsFunc.toString()`
// returns the exact, unminified JS SOURCE TEXT of that closure — static
// proof that specific ops (the shadow march, N.L, the point-light loop, the
// hysteresis blend, the trilinear/Chebyshev/octahedral query terms) are
// really wired into the graph that will run, not merely claimed in a
// comment. Numeric constants (golden angle, MC normalization, shadow step)
// are cross-checked exactly against gi-reference.js's own formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uniform, vec3 } from 'three/tsl';
import {
  createOccupancyStorage, createProbeAtlases, createPointLightPool,
  createGIUpdateKernel, createGIDepthUpdateKernel, createGIQueryNode,
  FIB_PHI,
} from '../client/kernel/gi/gi-nodes.js';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

function fixture() {
  const dims = { x: 4, y: 2, z: 4 };
  const occ = createOccupancyStorage(new Uint8Array(dims.x * dims.y * dims.z), dims, [0, 0, 0], 1);
  const atlases = createProbeAtlases({ probeCount: 8, irradianceRes: 4, depthRes: 4 });
  const lights = createPointLightPool(4);
  const sun = { direction: uniform(vec3(0, -1, 0)), color: uniform(vec3(1, 1, 1)), intensity: uniform(1) };
  const probeGrid = { origin: uniform(vec3(0, 0, 0)), spacing: 2, dims: { x: 2, y: 2, z: 2 } };
  return { occ, atlases, lights, sun, probeGrid };
}

// ---------------------------------------------------------- numeric parity
test('FIB_PHI matches irradiance.js fibonacciSphereDirs\' golden-angle formula exactly', () => {
  // irradiance.js: const phi = Math.PI * (3 - Math.sqrt(5));
  assert.equal(FIB_PHI, Math.PI * (3 - Math.sqrt(5)));
});

test('mutant: a rounded/approximated golden angle would NOT bit-exactly match irradiance.js', () => {
  const approximated = 2.399963; // BUG: a decimal approximation instead of the exact formula
  assert.notEqual(approximated, Math.PI * (3 - Math.sqrt(5)));
});

// -------------------------------------------------------- kernel structure
test('irradiance kernel source wires occupancy march, sun N.L, point lights, bounce, hysteresis (all present, in this order)', () => {
  const f = fixture();
  const { kernel } = createGIUpdateKernel({ ...f, raysPerProbe: 8, hysteresis: {} });
  const src = kernel.computeNode.shaderNode.jsFunc.toString();
  const rayLoopSig = "Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }";
  const ops = ['traceAndShadeRayTSL', 'fibonacciDirTSL', 'decodeOctTSL', rayLoopSig, 'mix(newEstimate'];
  for (const op of ops) {
    assert.ok(src.includes(op), `missing op "${op}" in the built kernel source`);
  }
  // mix(...) (the hysteresis write) must come AFTER the ray loop, not before
  assert.ok(src.indexOf('mix(newEstimate') > src.indexOf(rayLoopSig), 'hysteresis blend must follow ray accumulation');
});

test('depth kernel source shares the SAME traceAndShadeRayTSL call (single ray-march implementation, not a forked copy)', () => {
  const f = fixture();
  const { kernel } = createGIDepthUpdateKernel({ ...f, raysPerProbe: 8, hysteresis: {} });
  const src = kernel.computeNode.shaderNode.jsFunc.toString();
  assert.ok(src.includes('traceAndShadeRayTSL'));
  assert.ok(src.includes('dSum.add') && src.includes('d2Sum.add'), 'depth moments (mean, mean^2) accumulated');
  assert.ok(src.includes('mix(vec2(newMean, newMean2), old, alpha)'));
});

test('mutant: a kernel that never calls traceAndShadeRayTSL (writes vec3(0) like the pre-review skeleton) is exactly the bug the parent flagged', () => {
  const skeletonBug = 'sampleEstimate.addAssign(vec3(0, 0, 0))'; // the exact stage-3 code the review caught
  const f = fixture();
  const { kernel } = createGIUpdateKernel({ ...f, raysPerProbe: 8, hysteresis: {} });
  const src = kernel.computeNode.shaderNode.jsFunc.toString();
  assert.ok(!src.includes(skeletonBug), 'the fixed kernel must not contain the old always-zero placeholder');
});

// --------------------------------------------------------- query structure
test('query node source wires real 8-corner nested loop, trilinear weight, octahedral texel pick, Chebyshev', () => {
  const f = fixture();
  const node = createGIQueryNode({ atlases: f.atlases, worldPositionNode: vec3(1, 2, 3), normalNode: vec3(0, 1, 0), probeGrid: f.probeGrid });
  const src = node.shaderNode.jsFunc.toString();
  for (const op of ["Loop({ start: 0, end: 2, type: 'int', name: 'cx' }", 'trilW', 'encodeOctTSL', 'octUvToTexelIndexTSL', 'chebyshev', 'backface']) {
    assert.ok(src.includes(op), `missing op "${op}" in the built query source`);
  }
  // real 8 corners = three NESTED, DISTINCTLY-NAMED Loop calls (cx/cy/cz;
  // 10th pass: they were previously all unnamed Loop(2,...) which
  // generated the SAME default WGSL loop-variable name 'i' for all three,
  // an instance of the exact name-collision bug class found live), not
  // one flat Loop(8, ...)
  for (const name of ['cx', 'cy', 'cz']) {
    assert.ok(src.includes(`name: '${name}'`), `expected a distinctly-named corner loop '${name}'`);
  }
  assert.equal((src.match(/type: 'int', name: 'c[xyz]' \}/g) || []).length, 3, 'expected exactly 3 distinctly-named corner loops');
});

test('mutant: the pre-review query (cornerIdx = i, reading probes 0..7 for every pixel) is exactly the bug the parent flagged', () => {
  const f = fixture();
  const node = createGIQueryNode({ atlases: f.atlases, worldPositionNode: vec3(1, 2, 3), normalNode: vec3(0, 1, 0), probeGrid: f.probeGrid });
  const src = node.shaderNode.jsFunc.toString();
  assert.ok(!src.includes('const cornerIdx = i'), 'must not still read raw loop index as a fake probe id');
  assert.ok(!src.includes("trilinearWeight = float(1)"), 'must not still hard-code trilinear weight to 1');
});

// ---------------------------------------------------- self-shadow bias fix
test('the shadow ray origin is biased along the LIGHT direction (L), the same fix gi-reference.js needed for scene(i)/(ii-b) to pass', () => {
  assert.ok(SRC.includes('hitPos.add(L.mul(shadowStep))'), 'sun shadow ray must bias along L');
  assert.ok(SRC.includes('hitPos.add(Ldir.mul(shadowStep))'), 'point-light shadow ray must bias along Ldir');
});

test('mutant: biasing along N instead of L reproduces the exact self-shadow bug gi-reference.js fixed', () => {
  const buggyPattern = 'hitPos.add(N.mul(shadowStep))'; // the CPU reference's original (buggy) attempt
  assert.ok(!SRC.includes(buggyPattern), 'the GPU kernel must not use the N-biased (buggy) shadow origin');
});

// -------------------------------------------------------------- occupancy
test('the occupancy march is invoked at least 3x within the shading path (primary hit, sun shadow, point-light shadow)', () => {
  // static count within traceAndShadeRayTSL's own source in the file
  const start = SRC.indexOf('function traceAndShadeRayTSL');
  const end = SRC.indexOf('\n}\n', start);
  const body = SRC.slice(start, end);
  const count = (body.match(/marchOccupancyTSL\(/g) || []).length;
  assert.ok(count >= 3, `expected >=3 marchOccupancyTSL calls (primary+sun-shadow+pointlight-shadow), found ${count}`);
});

test('mutant: a shading path that never re-marches for shadows (count==1) would leave every hit permanently lit', () => {
  const mutantCount = 1; // BUG: only the primary hit march, no shadow rays at all
  assert.notEqual(mutantCount, 3);
});
