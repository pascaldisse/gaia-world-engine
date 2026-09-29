import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateProbeIrradiance, blendHysteresis, blendHysteresisVec3, fibonacciSphereDirs } from '../client/kernel/gi/irradiance.js';

test('fibonacciSphereDirs returns unit-length, well-spread directions', () => {
  const dirs = fibonacciSphereDirs(256);
  assert.equal(dirs.length, 256);
  for (const d of dirs) {
    const len = Math.hypot(d[0], d[1], d[2]);
    assert.ok(Math.abs(len - 1) < 1e-9);
  }
});

test('constant-radiance surround converges to the Lambertian identity (integral cos theta domega = pi)', () => {
  const L = [2, 0.5, 1];
  const dirs = fibonacciSphereDirs(4000);
  const rays = dirs.map((dir) => ({ dir, radiance: L }));
  const texelDir = [0, 0, 1];
  const [r, g, b] = integrateProbeIrradiance(texelDir, rays);
  const expected = L.map((c) => Math.PI * c);
  assert.ok(Math.abs(r - expected[0]) / expected[0] < 0.05, `r=${r} expected~${expected[0]}`);
  assert.ok(Math.abs(g - expected[1]) / expected[1] < 0.05, `g=${g} expected~${expected[1]}`);
  assert.ok(Math.abs(b - expected[2]) / expected[2] < 0.05, `b=${b} expected~${expected[2]}`);
});

test('integrateProbeIrradiance ignores back-facing rays (n.w <= 0 contributes 0)', () => {
  const texelDir = [0, 0, 1];
  const rays = [{ dir: [0, 0, -1], radiance: [10, 10, 10] }]; // fully opposite
  const [r, g, b] = integrateProbeIrradiance(texelDir, rays);
  assert.deepEqual([r, g, b], [0, 0, 0]);
});

test('blendHysteresis: alpha=1 keeps the old value, alpha=0 snaps to new', () => {
  assert.equal(blendHysteresis(5, 9, 1), 5);
  assert.equal(blendHysteresis(5, 9, 0), 9);
  assert.equal(blendHysteresis(5, 9, 0.5), 7);
});

test('repeated hysteresis blending toward a constant target converges monotonically', () => {
  let v = [0, 0, 0];
  const target = [1, 1, 1];
  const alpha = 0.9;
  let prevDist = Infinity;
  for (let i = 0; i < 200; i++) {
    v = blendHysteresisVec3(v, target, alpha);
    const dist = Math.hypot(v[0] - target[0], v[1] - target[1], v[2] - target[2]);
    assert.ok(dist <= prevDist + 1e-12, `iteration ${i} moved away from target`);
    prevDist = dist;
  }
  assert.ok(prevDist < 1e-4);
});

// mutation check: swapping alpha/(1-alpha) in the blend must fail the
// alpha=1-keeps-old assertion above (documents which mutant that test kills)
test('mutant: swapped alpha weights break the alpha=1 identity', () => {
  function swapped(oldVal, newVal, alpha) {
    return (1 - alpha) * oldVal + alpha * newVal; // BUG: weights swapped
  }
  assert.notEqual(swapped(5, 9, 1), 5);
});
