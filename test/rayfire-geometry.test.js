// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §16 #1 #2 + §2 determinism law (PRNG) + §3.5 oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshVolume, isWatertight, facesVolume, v3 } from '../client/extensions/rayfire/geometry.js';
import { createRng, mixSeed, rand01 } from '../client/extensions/rayfire/prng.js';
import { boxTriangles, flipAll, lPrism, V } from './helpers/rayfire-fixtures.js';

test('#1 unit box volume = 1 within 1e-9 (winding + formula); inverted box = -1', () => {
  assert.ok(Math.abs(meshVolume(boxTriangles()) - 1) < 1e-9);
  assert.ok(Math.abs(meshVolume(flipAll(boxTriangles())) + 1) < 1e-9);
  assert.ok(Math.abs(meshVolume(boxTriangles(V(-1, -1, -1), V(1, 1, 1), 3)) - 8) < 1e-9);
});

test('fixture: L prism is outward-wound (volume 3 = area 3 x h 1)', () => {
  assert.ok(Math.abs(meshVolume(lPrism(1)) - 3) < 1e-9);
});

test('#2 closed box watertight; single triangle NOT; empty NOT', () => {
  assert.equal(isWatertight(boxTriangles()), true);
  assert.equal(isWatertight(boxTriangles(V(0, 0, 0), V(1, 1, 1), 4)), true);
  assert.equal(isWatertight([[V(0, 0, 0), V(1, 0, 0), V(0, 1, 0)]]), false);
  assert.equal(isWatertight([]), false);
});

test('#2 discriminators: removed triangle, flipped triangle, duplicated triangle all NOT watertight', () => {
  const box = boxTriangles();
  assert.equal(isWatertight(box.slice(1)), false);
  const flipped = box.map((t, i) => (i === 3 ? [t[0], t[2], t[1]] : t));
  assert.equal(isWatertight(flipped), false);
  assert.equal(isWatertight([...box, box[5]]), false);
});

test('isWatertight accepts face[] and triangle[] alike; float-noise robust', () => {
  const box = boxTriangles();
  const faces = box.map(t => ({ verts: t, interior: false, materialId: 0 }));
  assert.equal(isWatertight(faces), true);
  const noisy = box.map(t => t.map(p => V(p.x + 1e-12, p.y - 1e-12, p.z)));
  assert.equal(isWatertight(noisy), true);
  const quad = [{ verts: [V(0, 0, 0), V(1, 0, 0), V(1, 1, 0), V(0, 1, 0)], interior: false, materialId: 0 }];
  assert.equal(isWatertight(quad), false);
  assert.ok(Math.abs(facesVolume(faces) - 1) < 1e-9);
});

test('v3 makes plain vec, defaults 0', () => {
  assert.deepEqual(v3(1, 2, 3), { x: 1, y: 2, z: 3 });
  assert.deepEqual(v3(), { x: 0, y: 0, z: 0 });
});

test('§2 PRNG: same seed same stream; different seed differs; seed coerced to uint32', () => {
  const a = createRng(5), b = createRng(5), c = createRng(6);
  const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()], sc = [c(), c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every(x => x >= 0 && x < 1));
  assert.deepEqual([createRng(-1)(), createRng(-1)()], [createRng(4294967295)(), createRng(4294967295)()]);
  assert.equal(createRng(1.9)(), createRng(1)());
});

test('§2 decorrelation: mixSeed(seed,saltA) != mixSeed(seed,saltB); rand01 keyed, stateless, in [0,1)', () => {
  assert.notEqual(mixSeed(7, 1), mixSeed(7, 2));
  assert.equal(mixSeed(7, 1), mixSeed(7, 1));
  assert.equal(rand01(3, 10, 20), rand01(3, 10, 20));
  assert.notEqual(rand01(3, 10, 20), rand01(3, 10, 21));
  assert.notEqual(rand01(3, 10, 20), rand01(4, 10, 20));
  for (let i = 0; i < 200; i++) { const r = rand01(9, i, i * 7); assert.ok(r >= 0 && r < 1); }
  // roughly uniform: mean of 2000 rolls near .5
  let s = 0; for (let i = 0; i < 2000; i++) s += rand01(1, i);
  assert.ok(Math.abs(s / 2000 - 0.5) < 0.05);
});

test('oracle: exactly-closed set with distinct points closer than the quantum is still watertight (exact keys tried first)', () => {
  // tetrahedron, diag ~1e3 -> quantum ~1.7e-6; B and C differ by 1e-10 so quantised keys merge them and the fixed-precision
  // check alone sees a repeated/degenerate edge set, while the exact edge structure is a perfect closed surface.
  const A = V(0, 0, 0), B = V(1000, 0, 0), C = V(1000, 1e-10, 0), D = V(500, 500, 800);
  const tetra = [[A, C, B], [A, B, D], [B, C, D], [C, A, D]]; // outward-consistent
  assert.equal(isWatertight(tetra), true);
  assert.equal(isWatertight(tetra.slice(1)), false);
});
