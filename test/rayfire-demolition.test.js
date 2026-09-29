// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §7 demolition orchestration, §16 #21-22.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demolishMesh, nextFragmentAmount, DEMOLITION_DEFAULTS } from '../client/extensions/rayfire/demolition.js';
import { isWatertight } from '../client/extensions/rayfire/geometry.js';
import { boxTriangles, deepFreeze, roundDeep, V } from './helpers/rayfire-fixtures.js';

const BOX = () => boxTriangles(V(-1, -1, -1), V(1, 1, 1));

test('#21 nextFragmentAmount = trunc(am*dpf) clamped >=3, exactly', () => {
  assert.equal(nextFragmentAmount(15, 0.5), 7);
  assert.equal(nextFragmentAmount(5, 0.5), 3);
  assert.equal(nextFragmentAmount(100, 0.1), 10);
  assert.equal(nextFragmentAmount(1, 0.5), 3);
  assert.equal(nextFragmentAmount(20, 0.5), 10);
  assert.equal(nextFragmentAmount(29, 1), 29);
  assert.equal(nextFragmentAmount(100, 0.29), 29, 'float fuzz (28.999999999999996) must not lose one');
  assert.equal(nextFragmentAmount(15, 0), 3);
  assert.equal(nextFragmentAmount(15, 0.6), 9); // trunc(9.0) -- rounding would also give 9; next line discriminates
  assert.equal(nextFragmentAmount(15, 0.55), 8); // trunc(8.25)=8, ceil would be 9
});

test('DEMOLITION_DEFAULTS: am15 var0 dpf.5 bias0 sd1, frozen', () => {
  assert.deepEqual({ ...DEMOLITION_DEFAULTS }, { am: 15, var: 0, dpf: 0.5, bias: 0, sd: 1 });
  assert.equal(Object.isFrozen(DEMOLITION_DEFAULTS), true);
});

test('#22 demolishMesh: volume conserved <1e-6; every child demolition.am = nextFragmentAmount(parentAm, dpf)', () => {
  for (const [am, dpf] of [[15, 0.5], [20, 0.3], [6, 0.9], [12, 0.1]]) {
    const frags = demolishMesh(BOX(), { am, dpf, sd: 5 });
    assert.ok(frags.length > 2);
    const sum = frags.reduce((s, f) => s + f.volume, 0);
    assert.ok(Math.abs(sum - 8) / 8 < 1e-6, `am ${am}: ${sum}`);
    for (const f of frags) assert.equal(f.demolition.am, nextFragmentAmount(am, dpf));
  }
});

test('fragment shape: index, faces, volume>=1e-9, centroid = MEAN of own vertices, aabb tight, depth, demolition descriptor, quality flags', () => {
  const frags = demolishMesh(BOX(), { am: 10, sd: 2, dpf: 0.4, var: 0, bias: 0 });
  frags.forEach((f, i) => {
    assert.equal(f.index, i);
    assert.equal(isWatertight(f.faces), true);
    assert.ok(f.volume >= 1e-9);
    const vs = f.faces.flatMap(fc => fc.verts);
    const m = vs.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(f.centroid.x - m.x / vs.length) < 1e-12 && Math.abs(f.centroid.y - m.y / vs.length) < 1e-12 && Math.abs(f.centroid.z - m.z / vs.length) < 1e-12);
    for (const k of ['x', 'y', 'z']) {
      assert.equal(f.aabb.min[k], Math.min(...vs.map(p => p[k])));
      assert.equal(f.aabb.max[k], Math.max(...vs.map(p => p[k])));
      assert.ok(f.aabb.min[k] <= f.centroid[k] && f.centroid[k] <= f.aabb.max[k]);
    }
    assert.equal(f.depth, 0);
    assert.deepEqual([f.demolition.var, f.demolition.dpf, f.demolition.bias, f.demolition.depth], [0, 0.4, 0, 1]);
    assert.equal(typeof f.demolition.sd, 'number');
    assert.equal(typeof f.uncappedLoops, 'boolean'); assert.equal(typeof f.hullFallback, 'boolean');
    assert.ok(f.seedPoint);
  });
  const sds = new Set(frags.map(f => f.demolition.sd));
  assert.ok(sds.size > 1, 're-demolition seeds are decorrelated per fragment');
});

test('defaults apply when opts missing/partial (consumer passes only {am, sd}); `depth` opt carries generation', () => {
  const a = demolishMesh(BOX(), {}), b = demolishMesh(BOX(), { am: 15, var: 0, dpf: 0.5, bias: 0, sd: 1 });
  assert.equal(roundDeep(a), roundDeep(b));
  const c = demolishMesh(BOX(), { am: 6, sd: 3 });
  assert.ok(c.length <= 6 && c.every(f => f.demolition.am === 3 && f.demolition.dpf === 0.5));
  const g = demolishMesh(BOX(), { am: 6, sd: 3, depth: 2 });
  assert.ok(g.every(f => f.depth === 2 && f.demolition.depth === 3));
});

test('deterministic per seed, seed-sensitive, input untouched (cacheable)', () => {
  const src = deepFreeze(BOX());
  assert.equal(roundDeep(demolishMesh(src, { am: 9, sd: 4 })), roundDeep(demolishMesh(src, { am: 9, sd: 4 })));
  assert.notEqual(roundDeep(demolishMesh(src, { am: 9, sd: 4 })), roundDeep(demolishMesh(src, { am: 9, sd: 5 })));
});

test('bias/var/biasPoint forwarded to the fracture core', () => {
  const corner = V(-1, -1, -1);
  const flat = demolishMesh(BOX(), { am: 20, sd: 3 }), biased = demolishMesh(BOX(), { am: 20, sd: 3, bias: 0.9, biasPoint: corner });
  assert.notEqual(roundDeep(flat), roundDeep(biased));
  const varied = new Set([1, 2, 3, 4, 5, 6].map(sd => demolishMesh(BOX(), { am: 20, sd, var: 50 }).length));
  assert.ok(varied.size > 1);
});

test('a source with no volume yields [] (no throw)', () => {
  assert.deepEqual(demolishMesh([], { am: 5 }), []);
});
