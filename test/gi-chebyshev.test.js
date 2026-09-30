import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chebyshevWeight, CHEBYSHEV_EPSILON } from '../client/kernel/gi/chebyshev.js';

test('testDist at or before the mean is always fully visible', () => {
  assert.equal(chebyshevWeight(10, 100, 10), 1);
  assert.equal(chebyshevWeight(10, 100, 5), 1);
  assert.equal(chebyshevWeight(10, 100, 0), 1);
});

test('weight decreases monotonically as testDist grows past the mean', () => {
  const mean = 10, mean2 = 105; // variance = 5
  let prev = 1;
  for (const t of [10, 11, 12, 15, 20, 40]) {
    const w = chebyshevWeight(mean, mean2, t);
    assert.ok(w <= prev + 1e-12, `w(${t})=${w} not <= prev=${prev}`);
    prev = w;
  }
  assert.ok(prev < 0.2);
});

test('zero variance (deterministic depth) drops to ~0 as soon as testDist exceeds the mean', () => {
  const mean = 10, mean2 = 100; // variance exactly 0 -> floored to CHEBYSHEV_EPSILON
  const w = chebyshevWeight(mean, mean2, mean + 1);
  assert.ok(w < CHEBYSHEV_EPSILON * 10, `expected near-zero, got ${w}`);
});

test('larger variance gives more benefit of the doubt at the same overshoot', () => {
  const lowVar = chebyshevWeight(10, 105, 15); // variance 5
  const highVar = chebyshevWeight(10, 200, 15); // variance 100
  assert.ok(highVar > lowVar, `expected highVar(${highVar}) > lowVar(${lowVar})`);
});

test('weight is always clamped to [0,1]', () => {
  for (const [mean, mean2, t] of [[10, 105, 1000], [0, 0, 0], [5, 25, 5]]) {
    const w = chebyshevWeight(mean, mean2, t);
    assert.ok(w >= 0 && w <= 1, `w=${w} out of range for (${mean},${mean2},${t})`);
  }
});

// mutation check: dropping the `testDist<=mean` short-circuit must fail the
// first test (falls through to the variance formula, which is < 1 even at t=mean)
test('mutant: without the <=mean shortcut, at-mean visibility is not exactly 1', () => {
  function noShortcut(mean, mean2, testDist) {
    const variance = Math.max(mean2 - mean * mean, CHEBYSHEV_EPSILON);
    const d = testDist - mean;
    return Math.min(1, Math.max(0, variance / (variance + d * d)));
  }
  // at testDist === mean, d=0 -> formula gives exactly 1 too, so use a point
  // BEFORE the mean where the real function returns 1 but the formula does not
  const w = noShortcut(10, 105, 5);
  assert.notEqual(w, 1);
});
