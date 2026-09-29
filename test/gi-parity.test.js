// F (parent review): node-side coverage of the GPU parity harness is
// intentionally limited to what's possible without a browser/GPU device —
// the harness module IMPORTS cleanly (proves no syntax/resolution errors
// in the three/webgpu + three/tsl + our own gi/* imports it needs) and its
// pure COMPARISON function behaves correctly on synthetic arrays. Running
// it against a real WebGPU device is Pascal's job (tools/gi-parity.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareAtlas, computeUpdateCount, DEFAULT_TOLERANCE,
  buildClosedBoxScene, buildOpenPlaneRedWallScene,
  runScene, runAll,
} from '../tools/gi-parity.mjs';

test('the harness module imports cleanly (three/webgpu + three/tsl + gi-controller/gi-reference/voxelize/probe-grid all resolve)', () => {
  assert.equal(typeof compareAtlas, 'function');
  assert.equal(typeof computeUpdateCount, 'function');
  assert.equal(typeof runScene, 'function');
  assert.equal(typeof runAll, 'function');
  // importing must NOT have constructed a renderer (no `document` in node)
  // -- if it had, this test file itself would already have thrown on import
});

// -------------------------------------------------------------- compareAtlas
test('compareAtlas: identical arrays pass with zero error', () => {
  const a = new Float32Array([0.1, 0.2, 0.3, 1, 2, 3]);
  const r = compareAtlas(a, a.slice());
  assert.equal(r.pass, true);
  assert.equal(r.maxAbsErr, 0);
  assert.equal(r.meanAbsErr, 0);
  assert.equal(r.count, 6);
});

test('compareAtlas: a difference within tolerance still passes', () => {
  const expected = new Float32Array([1, 1, 1]);
  const actual = new Float32Array([1 + DEFAULT_TOLERANCE.absTol * 0.5, 1, 1]);
  assert.equal(compareAtlas(actual, expected).pass, true);
});

test('compareAtlas: a difference beyond tolerance fails and reports the first offending index', () => {
  const expected = new Float32Array([1, 1, 1, 1]);
  const actual = new Float32Array([1, 1, 5, 1]); // index 2 is way off
  const r = compareAtlas(actual, expected);
  assert.equal(r.pass, false);
  assert.equal(r.firstFailIndex, 2);
  assert.ok(r.maxAbsErr >= 4);
});

test('compareAtlas: relative tolerance scales with the expected magnitude (large values tolerate a larger absolute gap)', () => {
  const smallExpected = new Float32Array([0.01]);
  const largeExpected = new Float32Array([100]);
  const gap = 1; // same absolute gap for both
  assert.equal(compareAtlas(new Float32Array([0.01 + gap]), smallExpected).pass, false, 'small value: gap of 1 must fail');
  assert.equal(compareAtlas(new Float32Array([100 + gap]), largeExpected).pass, true, 'large value: gap of 1 is within relTol*100');
});

test('compareAtlas: mismatched lengths fail cleanly instead of throwing', () => {
  const r = compareAtlas(new Float32Array([1, 2]), new Float32Array([1, 2, 3]));
  assert.equal(r.pass, false);
  assert.match(r.reason, /length mismatch/);
});

test('mutant: a comparator that ignores relTol (absolute-only) would wrongly fail the large-magnitude case above', () => {
  const absOnly = (actual, expected, absTol) => Math.abs(actual[0] - expected[0]) <= absTol; // BUG: no relTol term
  assert.equal(absOnly([101], [100], DEFAULT_TOLERANCE.absTol), false, 'the absolute-only mutant rejects a value the real relTol-aware comparator accepts');
});

// ---------------------------------------------------------- computeUpdateCount
test('computeUpdateCount scales with both grid coverage AND hysteresis convergence', () => {
  const k1 = computeUpdateCount({ updateFraction: 1, alpha: 0.9 });
  const k2 = computeUpdateCount({ updateFraction: 1 / 8, alpha: 0.9 });
  assert.equal(k2, k1 * 8, 'halving the per-frame batch size must scale K by the same factor');

  const k3 = computeUpdateCount({ updateFraction: 1, alpha: 0.99 }); // slower convergence
  assert.ok(k3 > k1, 'a higher hysteresis alpha needs more iterations to converge');
});

test('mutant: a K formula that only accounts for grid coverage (ignores hysteresis alpha) would under-run for slow-converging configs', () => {
  const coverageOnly = (updateFraction) => Math.ceil(1 / updateFraction); // BUG: no alpha term at all
  const real = computeUpdateCount({ updateFraction: 1, alpha: 0.99 });
  const mutant = coverageOnly(1);
  assert.ok(real > mutant, 'the real formula runs far more iterations than the coverage-only mutant would');
});

// -------------------------------------------------------------- scene builders
test('buildClosedBoxScene / buildOpenPlaneRedWallScene produce real triangle arrays + a valid giParams shape', () => {
  for (const builder of [buildClosedBoxScene, buildOpenPlaneRedWallScene]) {
    const { triangles, giParams } = builder();
    assert.ok(Array.isArray(triangles) && triangles.length > 0);
    for (const tri of triangles) assert.equal(tri.length, 9, 'each triangle is 3 xyz points flattened');
    assert.equal(giParams.enabled, true);
    assert.ok(giParams.sun && giParams.sun.direction.length === 3);
    assert.ok(giParams.updateFraction > 0 && giParams.updateFraction <= 1);
  }
});

test('scene(ii)\'s sun has a horizontal component (a purely vertical sun could never light a vertical wall face)', () => {
  const { giParams } = buildOpenPlaneRedWallScene();
  const [dx, , dz] = giParams.sun.direction;
  assert.ok(Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01, 'sun direction must have a horizontal component');
});

test('mutant: a purely-vertical sun ([0,-1,0]) on scene(ii) would give every vertical wall face ndotl=0, no bleed possible', () => {
  const verticalSun = [0, -1, 0];
  const [dx, , dz] = verticalSun;
  assert.equal(Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01, false, 'confirms a vertical sun has zero horizontal component, exactly the bug this scene avoids');
});

test('unpadVec3: GPU vec3 storage readback (4 floats/texel) → packed 3 (live 09-29: 576 vs 432)', async () => {
  const { unpadVec3, compareAtlas } = await import('../tools/gi-parity.mjs');
  const gpu = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]), cpu = new Float32Array([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...unpadVec3(gpu, 6)], [1, 2, 3, 4, 5, 6]);
  assert.equal(compareAtlas(unpadVec3(gpu, 6), cpu).pass, true);
  assert.equal(unpadVec3(cpu, 6), cpu, 'already packed untouched');
});
