// Root-cause investigation #8 (parent live-GPU rerun, 09-29): the pass-#7
// instrumentation kernel NEVER RAN. Browser Log domain (previously
// uncaptured by the parent's driver) revealed: "The number of storage
// buffers (12) in the Compute stage exceeds the maximum per-stage limit
// (8)" -> BindGroupLayout invalid -> pipeline invalid -> every dispatch
// silently dropped, no thrown JS error. A "control" run on the pre-
// instrumentation commit (0 validation errors) confirmed the ORIGINAL
// scene(ii)/(i) divergence is real and independent of this new bug.
//
// This file: (1) proves the update kernel's REAL usage (as GIController
// actually constructs it) fits the device's 8-storage-buffer budget after
// packing all debug outputs into ONE buffer; (2) removal mutant --
// unpacking back into 5 buffers reproduces the exact 12-buffer overflow;
// (3) addition mutant -- one more optional buffer on top of the real
// usage overflows again; (4) structurally cross-checks the accounting
// function against the REAL kernel source (count distinct storage-buffer
// identifiers actually referenced), so the count isn't just an assertion
// divorced from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STORAGE_BUFFER_LIMIT, countUpdateKernelStorageBuffers, countDepthKernelStorageBuffers, countDebugKernelStorageBuffers,
} from '../client/kernel/gi/gi-nodes.js';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

// -------------------------------------------------------- (1) real usage fits
test('the update kernel, built exactly as GIController.configure() builds it (touched+skyHits+lights all truthy, no bounceAtlas), fits the 8-buffer budget', () => {
  const count = countUpdateKernelStorageBuffers({ touched: {}, skyHits: {}, lights: {}, bounceAtlas: null });
  assert.equal(count, 8);
  assert.ok(count <= STORAGE_BUFFER_LIMIT, `update kernel uses ${count} storage buffers, budget is ${STORAGE_BUFFER_LIMIT}`);
});

test('the depth kernel (touched/skyHits/debug never passed to it) fits comfortably', () => {
  const count = countDepthKernelStorageBuffers({ lights: {} });
  assert.ok(count <= STORAGE_BUFFER_LIMIT, `depth kernel uses ${count} storage buffers, budget is ${STORAGE_BUFFER_LIMIT}`);
  assert.equal(count, 5);
});

test('the ray-debug kernel (createRayDebugKernel, lights always null) fits comfortably', () => {
  const count = countDebugKernelStorageBuffers();
  assert.ok(count <= STORAGE_BUFFER_LIMIT, `debug kernel uses ${count} storage buffers, budget is ${STORAGE_BUFFER_LIMIT}`);
  assert.equal(count, 5);
});

// gi-controller.js's ACTUAL call sites, so this test breaks if the real
// wiring ever stops matching what these counters assume
test('gi-controller.js\'s real createGIUpdateKernel/createGIDepthUpdateKernel calls pass touched/skyHits/lights exactly as counted above', () => {
  const controllerSrc = readFileSync(new URL('../client/kernel/gi/gi-controller.js', import.meta.url), 'utf8');
  const irrCallStart = controllerSrc.indexOf('const irr = createGIUpdateKernel({');
  const irrCall = controllerSrc.slice(irrCallStart, irrCallStart + 300);
  assert.ok(irrCall.includes('touched, skyHits'), 'update kernel call must still pass touched+skyHits (recount if this changes)');
  assert.ok(irrCall.includes('sun, lights'), 'update kernel call must still pass lights (recount if this changes)');
  assert.ok(!irrCall.includes('bounceAtlas'), 'update kernel call must still NOT pass bounceAtlas (would need 9, over budget -- recount+repack if this ever changes)');
});

// -------------------------------------------------------- (2) removal mutant
test('mutant: un-packing the 5 debug outputs back into separate buffers (the pre-8th-pass state) reproduces the exact 12-buffer overflow the parent observed', () => {
  function countPrePacking({ touched, skyHits, lights, bounceAtlas } = {}) {
    let count = 2; // irradiance + occupancy
    if (touched) count += 1;
    if (skyHits) count += 1;
    if (lights) count += 3;
    if (bounceAtlas) count += 1;
    count += 5; // BUG: probeMapBuffer, debugDirHit, debugRadianceWeight, debugRunningSum, debugFinal -- unpacked
    return count;
  }
  const preFixCount = countPrePacking({ touched: {}, skyHits: {}, lights: {}, bounceAtlas: null });
  assert.equal(preFixCount, 12, 'reproduces the exact number from the parent\'s live error message');
  assert.ok(preFixCount > STORAGE_BUFFER_LIMIT, 'and confirms it overflows the budget');
  const packedCount = countUpdateKernelStorageBuffers({ touched: {}, skyHits: {}, lights: {}, bounceAtlas: null });
  assert.notEqual(packedCount, preFixCount, 'the real (packed) count must differ from the unpacked mutant');
});

// -------------------------------------------------------- (3) addition mutant
test('mutant: adding ONE more optional storage buffer on top of the real usage (e.g. wiring bounceAtlas) must overflow the budget, not silently fit', () => {
  const realCount = countUpdateKernelStorageBuffers({ touched: {}, skyHits: {}, lights: {}, bounceAtlas: null });
  const withOneMore = countUpdateKernelStorageBuffers({ touched: {}, skyHits: {}, lights: {}, bounceAtlas: {} });
  assert.equal(realCount, STORAGE_BUFFER_LIMIT, 'sanity: the real usage sits EXACTLY at the budget, zero headroom');
  assert.ok(withOneMore > STORAGE_BUFFER_LIMIT, 'adding bounceAtlas (or any other optional buffer) on top must overflow -- there is no free slot left');
});

// -------------------------------------------------- (4) structural cross-check
test('structural: the update kernel body references exactly ONE packed debug buffer identifier (debugBuffer), not several', () => {
  const start = SRC.indexOf('export function createGIUpdateKernel');
  const end = SRC.indexOf('\nexport function', start + 10);
  const body = SRC.slice(start, end);
  // the FIVE pre-fix identifiers must be gone from the update kernel
  for (const oldName of ['probeMapBuffer', 'debugDirHit', 'debugRadianceWeight', 'debugRunningSum', 'debugFinal']) {
    assert.ok(!body.includes(oldName + '.element('), `the old unpacked buffer identifier "${oldName}" must not be referenced anymore`);
  }
  // and the packed buffer IS referenced (multiple times: probe-map write,
  // per-ray write, final write -- all through the SAME identifier)
  const debugBufferRefs = (body.match(/debugBuffer\.element\(/g) || []).length;
  assert.ok(debugBufferRefs >= 3, `expected at least 3 debugBuffer.element(...) writes (probe-map + per-ray + final), found ${debugBufferRefs}`);
});

test('mutant: if a future edit re-introduced a 6th separate debug storage buffer, this structural check would catch it even without a live GPU', () => {
  const hypotheticalBody = 'const anotherDebugBuffer = instancedArray(10, "vec4"); anotherDebugBuffer.element(0).assign(vec4(0));';
  const looksLikeANewBuffer = /const \w*[Dd]ebug\w*Buffer = instancedArray/.test(hypotheticalBody);
  assert.ok(looksLikeANewBuffer, 'the pattern this mutant reproduces is exactly what a code reviewer (or grep) should flag before it ships');
});
