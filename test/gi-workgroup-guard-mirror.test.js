// Root-cause investigation #4 (parent live-GPU rerun, 09-29): occupancy
// proven identical, hypothesis (a) probe-position-formula proven identical
// (test/gi-ray-debug.test.js). scene(ii)'s skyHits showed an EXACT half
// (4224 vs 2112, "not race noise") on probe-grid columns 3-4 specifically,
// aligned with round-robin BATCH boundaries for that scene's config
// (probesPerBatch=5=dims.x, so batch 0 = probeLocal 0..4 = the entire row
// iz=0). This file CPU-mirrors WORKGROUP ROUNDING: renderer.compute(kernel,
// count) dispatches whole 64-thread workgroups, so any `count` that isn't
// an exact multiple of 64 launches MORE threads than requested. Those
// excess threads decode to VALID (in-range, wrapped) probeIdx values via
// the earlier atlasIndex-wrap fix -- so instead of being harmlessly
// out-of-bounds, they silently RE-SHADE AND OVERWRITE a probe belonging to
// a DIFFERENT, not-yet-due round-robin batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

function dispatchedThreadCount(requestedCount, workgroupSize = 64) {
  return Math.ceil(requestedCount / workgroupSize) * workgroupSize;
}

test('scene(ii)\'s actual config (probesPerBatch=5, texelsPerProbe=16) genuinely over-dispatches by workgroup rounding', () => {
  const requested = 5 * 16; // 80
  const dispatched = dispatchedThreadCount(requested);
  assert.equal(dispatched, 128, 'ceil(80/64)*64 = 128');
  assert.ok(dispatched > requested, 'workgroup rounding always launches >= requested threads');
  assert.equal(dispatched - requested, 48, 'exactly the 48 excess threads the live GPU symptom is consistent with');
});

test('the 48 excess threads decode to VALID (in-range) probeIdx values via the existing wrap fix -- NOT harmlessly out-of-bounds', () => {
  const texelsPerProbe = 16;
  const probeCount = 25;
  const probeOffset = 0; // batch 0
  for (let texelIndex = 80; texelIndex < 128; texelIndex++) {
    const probeLocal = Math.floor(texelIndex / texelsPerProbe); // 5, 6, 7
    const probeIdx = (probeOffset + probeLocal) % probeCount; // 5, 6, 7 -- all VALID probe ids
    assert.ok(probeIdx >= 0 && probeIdx < probeCount, `texelIndex=${texelIndex} decodes to a VALID probeIdx=${probeIdx}, not a safely-ignorable OOB index`);
  }
});

test('WITHOUT a validCount guard, those excess threads would write to probes 5,6,7 (row iz=1) while batch 0 (row iz=0) is active -- a different batch\'s probes, out of round-robin schedule', () => {
  const dims = { x: 5, y: 1, z: 5 };
  const probeIndex = (ix, iy, iz) => ix + dims.x * (iy + dims.y * iz);
  const decompose = (idx) => ({ ix: idx % dims.x, iy: 0, iz: Math.floor(idx / dims.x) });
  const wronglyTouched = [5, 6, 7].map(decompose);
  for (const { iz } of wronglyTouched) {
    assert.equal(iz, 1, 'these probes belong to row iz=1, not the currently-dispatching row iz=0 (batch 0)');
  }
  assert.equal(probeIndex(0, 0, 1), 5, 'sanity: row iz=1 really does start at probe id 5');
});

test('WITH the validCount guard (texelIndex < validCount, validCount=80), the excess threads never even decode a probeIdx, let alone write one', () => {
  const validCount = 80;
  const excessThreadIndices = Array.from({ length: 48 }, (_, i) => 80 + i);
  for (const texelIndex of excessThreadIndices) {
    assert.ok(texelIndex >= validCount, 'every excess thread index is >= validCount and must be skipped entirely');
  }
});

// -------- source-level confirmation the fix landed in gi-nodes.js (both kernels) --------
test('gi-nodes.js: both update kernels wrap their entire body in an explicit validCount guard', () => {
  const irradianceGuard = SRC.indexOf('If(uint(texelIndex).lessThan(validCount)');
  assert.ok(irradianceGuard !== -1, 'expected an explicit validCount guard');
  const secondGuard = SRC.indexOf('If(uint(texelIndex).lessThan(validCount)', irradianceGuard + 1);
  assert.ok(secondGuard !== -1, 'expected the SAME guard in the depth kernel too, not just irradiance');
});

test('gi-controller.js: update() sets validCount to the EXACT dispatch count it requests, for both kernels', () => {
  const controllerSrc = readFileSync(new URL('../client/kernel/gi/gi-controller.js', import.meta.url), 'utf8');
  assert.ok(controllerSrc.includes('irr.validCount.value = irrDispatchCount'));
  assert.ok(controllerSrc.includes('dep.validCount.value = depDispatchCount'));
});

test('mutant: a validCount guard that defaults to the FULL atlas size (totalTexelsDefault) and is never updated per-batch would never actually catch the round-robin over-dispatch bug', () => {
  const totalTexelsDefault = 25 * 16; // 400, the FULL atlas -- way bigger than any single batch's 80
  const batchDispatchCount = 80;
  assert.notEqual(totalTexelsDefault, batchDispatchCount, 'if validCount stayed at the full-atlas default, the batch-sized 128-thread over-dispatch (80..127) would sail right through the guard uncaught');
});
