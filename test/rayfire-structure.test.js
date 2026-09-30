// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §8-10 anchors/connectivity/support/erosion, §16 #23-29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInBox, markUnyielding, buildAdjacency, assignJointStrength, breakJoints, connectedComponents, partitionByUnyielding,
  computeSupport, tickErosion,
} from '../client/extensions/rayfire/structure.js';
import { demolishMesh } from '../client/extensions/rayfire/demolition.js';
import { boxTriangles, V } from './helpers/rayfire-fixtures.js';

// unit-cube fragment centred at c
const frag = (x, y, z, volume = 1) => ({ volume, centroid: V(x, y, z), aabb: { min: V(x - 0.5, y - 0.5, z - 0.5), max: V(x + 0.5, y + 0.5, z + 0.5) } });
const stack = n => Array.from({ length: n }, (_, i) => frag(0, i, 0));
const chainX = n => Array.from({ length: n }, (_, i) => frag(i, 0, 0));
const joint = (i, j, extra = {}) => ({ i, j, broken: false, ...extra });
const jointsOf = edges => edges.map(([i, j]) => joint(i, j));

test('pointInBox is inclusive on every face, half-size on each axis', () => {
  const box = { center: V(1, 2, 3), size: V(2, 4, 6) };
  assert.equal(pointInBox(V(1, 2, 3), box), true);
  assert.equal(pointInBox(V(2, 4, 6), box), true, 'max corner inclusive');
  assert.equal(pointInBox(V(0, 0, 0), box), true, 'min corner inclusive');
  assert.equal(pointInBox(V(2.0001, 2, 3), box), false);
  assert.equal(pointInBox(V(1, -0.0001, 3), box), false);
  assert.equal(pointInBox(V(1, 2, 6.0001), box), false);
});

test('#23 markUnyielding: CENTROID test (not AABB overlap), returns count, others untouched', () => {
  const fs = [frag(0, 0, 0), frag(0, 1, 0), frag(0, 2, 0), frag(0, 3, 0)];
  const box = { center: V(0, 0.9, 0), size: V(4, 2, 4) }; // spans y -0.1..1.9: centroids 0 and 1 inside; frag2 AABB (1.5..2.5) overlaps but centroid 2 is outside
  const n = markUnyielding(fs, box);
  assert.equal(n, 2);
  assert.deepEqual(fs.map(f => f.unyielding === true), [true, true, false, false]);
  assert.equal(fs[2].unyielding, undefined, 'outside fragments stay untouched (undefined)');
  assert.equal(markUnyielding(fs, { center: V(50, 50, 50), size: V(1, 1, 1) }), 0);
});

test('#24 buildAdjacency: 4-chain connects only touching neighbours (0-1,1-2,2-3); expand adds slack', () => {
  assert.deepEqual(buildAdjacency(chainX(4), {}), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(buildAdjacency(chainX(4)), [[0, 1], [1, 2], [2, 3]]);
  const gap = [frag(0, 0, 0), frag(1.02, 0, 0)];
  assert.deepEqual(buildAdjacency(gap, {}), []);
  assert.deepEqual(buildAdjacency(gap, { expand: 0.02 }), [[0, 1]], 'each AABB is grown by expand on all sides');
  assert.deepEqual(buildAdjacency(gap, { expand: 0.011 }), [[0, 1]]);
  assert.deepEqual(buildAdjacency(gap, { expand: 0.009 }), []);
  assert.deepEqual(buildAdjacency([frag(0, 0, 0), frag(0.5, 0.5, 0.5), frag(3, 3, 3)], {}), [[0, 1]]);
  assert.deepEqual(buildAdjacency([], {}), []);
});

test('buildAdjacency on real fracture cells: every cell has a neighbour, graph connected (they tile a box)', () => {
  const frags = demolishMesh(boxTriangles(V(-1, -1, -1), V(1, 1, 1)), { am: 12, sd: 3 });
  const edges = buildAdjacency(frags, { expand: 0.02 });
  const comps = connectedComponents(frags.length, edges.map(([i, j]) => joint(i, j)));
  assert.equal(comps.length, 1);
});

test('assignJointStrength: breakForce +/- var seeded per joint, >=0, forceByMass scales by summed mass, deterministic', () => {
  const fs = chainX(4); fs[1].volume = 3;
  const edges = buildAdjacency(fs, {});
  const a = assignJointStrength(edges, fs, {}), b = assignJointStrength(edges, fs, {});
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  for (const j of a) { assert.equal(j.broken, false); assert.ok(j.strength >= 90 && j.strength <= 110, `strength ${j.strength}`); }
  assert.ok(new Set(a.map(j => j.strength)).size > 1, 'variation is per joint');
  const c = assignJointStrength(edges, fs, { seed: 2 });
  assert.notDeepEqual(a.map(j => j.strength), c.map(j => j.strength));
  const z = assignJointStrength(edges, fs, { breakForce: 5, breakForceVar: 50 });
  assert.ok(z.every(j => j.strength >= 0));
  const m = assignJointStrength(edges, fs, { breakForce: 10, breakForceVar: 0, forceByMass: true });
  assert.deepEqual(m.map(j => j.strength), [10 * (1 + 3), 10 * (3 + 1), 10 * (1 + 1)]);
  const plain = assignJointStrength(edges, fs, { breakForce: 10, breakForceVar: 0 });
  assert.deepEqual(plain.map(j => j.strength), [10, 10, 10]);
});

test('breakJoints: breaks when MAX(forceAt(i),forceAt(j)) > strength; skips broken; returns count', () => {
  const js = [joint(0, 1, { strength: 10 }), joint(1, 2, { strength: 10 }), joint(2, 3, { strength: 10, broken: true })];
  const force = [0, 20, 5, 100];
  assert.equal(breakJoints(js, i => force[i]), 2); // joint0 max(0,20)>10, joint1 max(20,5)>10, joint2 already broken
  assert.deepEqual(js.map(j => j.broken), [true, true, true]);
  const j2 = [joint(0, 1, { strength: 10 })];
  assert.equal(breakJoints(j2, () => 10), 0, 'equal is not exceeding');
  assert.equal(j2[0].broken, false);
  const rep = [joint(0, 1, { strength: 10 })];
  assert.equal(breakJoints(rep, () => 11), 1); assert.equal(breakJoints(rep, () => 11), 0, 'already-broken skipped, not recounted');
});

test('connectedComponents: over surviving joints only; sorted; isolated fragments are their own component', () => {
  const js = jointsOf([[0, 1], [1, 2], [3, 4]]);
  assert.deepEqual(connectedComponents(6, js), [[0, 1, 2], [3, 4], [5]]);
  js[1].broken = true;
  assert.deepEqual(connectedComponents(6, js), [[0, 1], [2], [3, 4], [5]]);
  assert.deepEqual(connectedComponents(0, []), []);
});

test('partitionByUnyielding: component with >=1 anchor is held, none -> released', () => {
  const fs = chainX(5); fs[0].unyielding = true; fs[4].unyielding = true;
  const { held, released } = partitionByUnyielding([[0, 1], [2, 3], [4]], fs);
  assert.deepEqual(held, [[0, 1], [4]]);
  assert.deepEqual(released, [[2, 3]]);
});

test('#25 4-chain, fragment 0 anchored, break MIDDLE joint -> held {0,1}, released {2,3}', () => {
  const fs = chainX(4); fs[0].unyielding = true;
  const js = jointsOf(buildAdjacency(fs, {}));
  assert.equal(partitionByUnyielding(connectedComponents(4, js), fs).released.length, 0, 'intact chain: everything held');
  js[1].broken = true; // 1-2
  const { held, released } = partitionByUnyielding(connectedComponents(4, js), fs);
  assert.deepEqual(held, [[0, 1]]);
  assert.deepEqual(released, [[2, 3]]);
});

test('#26 vertical stack anchored at base: computeSupport all true through the 45 deg cone', () => {
  const fs = stack(5); fs[0].unyielding = true;
  const js = jointsOf(buildAdjacency(fs, {}));
  assert.deepEqual(computeSupport(fs, js, {}), [true, true, true, true, true]);
  assert.deepEqual(computeSupport(fs, js), [true, true, true, true, true]);
});

test('#27 fragment offset OUTSIDE the cone: it and everything only reachable through it are NOT supported; cone angle is the discriminator', () => {
  const fs = [frag(0, 0, 0), frag(0, 1, 0), frag(2.5, 1.9, 0), frag(2.5, 2.9, 0)]; // 0->1 up; 1->2: dx 2.5 dy .9 => ~70deg off vertical
  fs[0].unyielding = true;
  const js = jointsOf([[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(computeSupport(fs, js, {}), [true, true, false, false]);
  assert.deepEqual(computeSupport(fs, js, { support: 80 }), [true, true, true, true], 'widening the cone supports it');
  assert.deepEqual(computeSupport(fs, js, { support: 10 }), [true, true, false, false]);
  // support must NOT propagate downward: anchor on top of a stack supports nothing below
  const st = stack(3); st[2].unyielding = true;
  assert.deepEqual(computeSupport(st, jointsOf([[0, 1], [1, 2]]), {}), [false, false, true]);
});

test('computeSupport: broken joints do not carry support; gravity param defines up; joint order irrelevant', () => {
  const fs = stack(4); fs[0].unyielding = true;
  const js = jointsOf([[0, 1], [1, 2], [2, 3]]); js[1].broken = true;
  assert.deepEqual(computeSupport(fs, js, {}), [true, true, false, false]);
  const sideways = chainX(3); sideways[0].unyielding = true;
  assert.deepEqual(computeSupport(sideways, jointsOf([[0, 1], [1, 2]]), { gravity: V(-1, 0, 0) }), [true, true, true], 'gravity -x => up is +x');
  assert.deepEqual(computeSupport(sideways, jointsOf([[0, 1], [1, 2]]), {}), [true, false, false], 'default gravity: +x neighbours are 90deg off up');
  const st = stack(3); st[0].unyielding = true;
  assert.deepEqual(computeSupport(st, jointsOf([[2, 1], [1, 0]]), {}), [true, true, true], 'joint (i,j) order does not matter');
});

test('#28 supported stack; clear the base anchor -> ALL false (an anchor is the only source of support)', () => {
  const fs = stack(4); fs[0].unyielding = true;
  const js = jointsOf(buildAdjacency(fs, {}));
  assert.ok(computeSupport(fs, js, {}).some(Boolean));
  fs[0].unyielding = false;
  assert.deepEqual(computeSupport(fs, js, {}), [false, false, false, false]);
  assert.deepEqual(computeSupport([], [], {}), []);
});

test('#29 unsupported stack: tickErosion breaks a joint within a bounded number of ticks; supported joints NEVER erode', () => {
  const fs = stack(4);
  const js = jointsOf(buildAdjacency(fs, {}));
  const none = [false, false, false, false];
  let first = -1, total = 0;
  for (let t = 1; t <= 250 && first < 0; t++) { const n = tickErosion(js, fs, none, {}); total += n; if (n > 0) first = t; }
  assert.ok(first > 0 && first <= 250, 'no joint eroded');
  assert.equal(js.filter(j => j.broken).length, total);
  assert.ok(js.every(j => j.stress > 0), 'stress accumulates on unsupported joints');
  // supported joints never erode
  const sfs = stack(4); sfs[0].unyielding = true;
  const sj = jointsOf(buildAdjacency(sfs, {}));
  for (let t = 0; t < 5000; t++) tickErosion(sj, sfs, [true, true, true, true], { erosion: 1000 });
  assert.ok(sj.every(j => !j.broken && !(j.stress > 0)), 'supported joint eroded');
  // one supported endpoint is enough to stress it
  const mj = jointsOf([[0, 1]]);
  tickErosion(mj, stack(2), [true, false], { erosion: 1000 });
  assert.equal(mj[0].broken, true);
});

test('tickErosion knobs: erosion scales stress, threshold gates, broken skipped, returns newly-broken count; heavy hanging piece stresses more', () => {
  const fs = stack(2); const a = jointsOf([[0, 1]]), b = jointsOf([[0, 1]]);
  tickErosion(a, fs, [false, false], { erosion: 1 }); tickErosion(b, fs, [false, false], { erosion: 3 });
  assert.ok(Math.abs(b[0].stress - 3 * a[0].stress) < 1e-9);
  assert.equal(tickErosion(a, fs, [false, false], { threshold: 0.5 }), 1);
  assert.equal(tickErosion(a, fs, [false, false], { threshold: 0.5 }), 0, 'already broken');
  const light = [frag(0, 0, 0, 1), frag(0, -1, 0, 1)], heavy = [frag(0, 0, 0, 1), frag(0, -1, 0, 5)];
  const jl = jointsOf([[0, 1]]), jh = jointsOf([[0, 1]]);
  tickErosion(jl, light, [false, false], {}); tickErosion(jh, heavy, [false, false], {});
  assert.ok(jh[0].stress > jl[0].stress * 4.9, 'sizeRatio = volume(hanging)/volume(upper)');
  // joint order (i,j) vs (j,i) must not change the stress: orientation-normalised
  const f1 = jointsOf([[0, 1]]), f2 = jointsOf([[1, 0]]);
  tickErosion(f1, stack(2), [false, false], {}); tickErosion(f2, stack(2), [false, false], {});
  assert.ok(Math.abs(f1[0].stress - f2[0].stress) < 1e-12);
});

test('#35-part end-to-end on real fracture: anchor ground band, supported >=1; clear anchors -> all false', () => {
  const frags = demolishMesh(boxTriangles(V(0, 0, 0), V(2, 6, 2)), { am: 24, sd: 11 });
  const js = jointsOf(buildAdjacency(frags, { expand: 0.02 }));
  const n = markUnyielding(frags, { center: V(1, 0.5, 1), size: V(4, 1.6, 4) });
  assert.ok(n > 0 && n < frags.length);
  const sup = computeSupport(frags, js, {});
  assert.ok(sup.filter(Boolean).length >= n);
  for (const f of frags) f.unyielding = false;
  assert.ok(computeSupport(frags, js, {}).every(v => v === false));
});

test('#23b markUnyielding discriminator: centroid INSIDE but AABB extends outside -> marked; AABB overlaps but centroid OUTSIDE -> not', () => {
  const box = { center: V(0, 0, 0), size: V(2, 2, 2) };
  const bigInside = { volume: 1, centroid: V(0, 0, 0), aabb: { min: V(-9, -9, -9), max: V(9, 9, 9) } };
  const overlapOutside = { volume: 1, centroid: V(5, 0, 0), aabb: { min: V(0.5, -1, -1), max: V(9.5, 1, 1) } };
  const fs = [bigInside, overlapOutside];
  assert.equal(markUnyielding(fs, box), 1);
  assert.equal(fs[0].unyielding, true);
  assert.equal(fs[1].unyielding, undefined);
});

test('#24b buildAdjacency: separation on y alone or z alone (x overlapping) is NOT adjacency; overlap on all three axes is', () => {
  assert.deepEqual(buildAdjacency([frag(0, 0, 0), frag(0, 5, 0)], {}), [], 'y gap');
  assert.deepEqual(buildAdjacency([frag(0, 5, 0), frag(0, 0, 0)], {}), [], 'y gap, reversed order');
  assert.deepEqual(buildAdjacency([frag(0, 0, 0), frag(0, 0, 5)], {}), [], 'z gap');
  assert.deepEqual(buildAdjacency([frag(0, 0, 0), frag(0.2, 0.2, 0.2)], {}), [[0, 1]]);
  assert.deepEqual(buildAdjacency([frag(0, 0, 0), frag(0, 0, 5), frag(0, 5, 0), frag(5, 0, 0)], {}), []);
});
