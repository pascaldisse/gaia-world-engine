import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeOct, decodeOct } from '../client/kernel/gi/octahedral.js';

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function closeVec(a, b, eps = 1e-9, msg) {
  assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps, msg ?? `${a} != ${b}`);
}

test('round-trips axis directions exactly', () => {
  const axes = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  for (const a of axes) closeVec(decodeOct(encodeOct(a)), a);
});

test('round-trips many scattered directions within tolerance', () => {
  // deterministic scatter, no RNG dependency across runs
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 500; i++) {
    const v = normalize([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
    closeVec(decodeOct(encodeOct(v)), v, 1e-6, `direction #${i}: ${v}`);
  }
});

test('encode stays inside the [-1,1]^2 footprint', () => {
  const v = normalize([0.3, -0.7, 0.2]);
  const [u, w] = encodeOct(v);
  assert.ok(u >= -1 && u <= 1 && w >= -1 && w <= 1);
});

// removal-style mutation check: dropping the z<0 fold branch must break the
// lower-hemisphere round-trip while leaving the upper hemisphere untouched
// (proves the test actually exercises the fold, not just the identity path)
test('mutant: encode without the lower-hemisphere fold fails round-trip', () => {
  function encodeNoFold(dir) {
    const [x, y, z] = dir;
    const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
    const inv = l1 > 0 ? 1 / l1 : 0;
    return [x * inv, y * inv]; // BUG: no fold for z<0
  }
  const v = normalize([0.5, 0.5, -0.5]); // lower hemisphere
  const decoded = decodeOct(encodeNoFold(v));
  const err = Math.hypot(decoded[0] - v[0], decoded[1] - v[1], decoded[2] - v[2]);
  assert.ok(err > 0.05, `expected the un-folded mutant to diverge, err=${err}`);
});
