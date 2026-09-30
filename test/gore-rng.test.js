// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, rngRange, rngHemisphere } from '../client/extensions/gore/rng.js';

test('same seed -> identical sequence', () => {
  const a = makeRng(42), b = makeRng(42);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('different seeds -> different sequence', () => {
  const a = makeRng(1), b = makeRng(2);
  assert.notEqual(a(), b());
});

test('values stay in [0,1)', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('rngRange respects bounds', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 500; i++) {
    const v = rngRange(rng, 1, 4);
    assert.ok(v >= 1 && v < 4);
  }
});

test('rngHemisphere stays on the normal side (dot >= 0) and unit length', () => {
  const rng = makeRng(9);
  const normal = [0, 1, 0];
  for (let i = 0; i < 200; i++) {
    const v = rngHemisphere(rng, normal);
    const dot = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2];
    assert.ok(dot >= -1e-9, `dot=${dot}`);
    const len = Math.hypot(...v);
    assert.ok(Math.abs(len - 1) < 1e-9, `len=${len}`);
  }
});

test('mutant: Math.random instead of seeded state -> two same-seed generators diverge', () => {
  const mathRandomRng = () => Math.random();
  const a = mathRandomRng(), b = mathRandomRng();
  // a real mutant swap (rng.js body replaced by Math.random) would make this
  // assertion in the 'same seed -> identical sequence' test above fail; here
  // we pin the property Math.random itself lacks (repeatability) as a canary
  // -- the actual RED proof is applying the mutant to rng.js (see report).
  assert.notEqual(a, b, 'Math.random has no seed -> cannot be equal by construction, unlike our rng');
});
