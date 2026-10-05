// GIController mode:'open' wiring (headless: renderer is a spy; no GPU). API for BP: configure / addMesh / removeMesh / update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { planCascadeBatches, buildCascades } from '../client/kernel/gi/cascade.js';
import { setBatch, createBatchUniforms } from '../client/kernel/gi/gi-open-nodes.js';
import { loadMutant } from './helpers/mutant.js';

const quad = (y, x0, x1, z0, z1) => [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
const mk = () => { const calls = []; const renderer = { compute: (k, n) => calls.push(n) }; const gi = new GIController({ renderer, scene: new THREE.Scene() }); return { gi, calls }; };
const OPEN = { enabled: true, mode: 'open', raysPerProbe: 16, voxel: { bricks: { x: 4, y: 2, z: 4 } }, cascades: { dims: [{ x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }] } };

test('open mode: configure builds cascades+voxel storage+kernels; RTS resources absent', () => {
  const { gi } = mk(); assert.equal(gi.configure(OPEN), true);
  assert.ok(gi.resources.open && gi.resources.queryNode && !gi.resources.grid);
  assert.equal(gi.resources.open.cascades.length, 3);
  assert.equal(gi.resources.open.atlases.probeCount, 3 * 64);
});
test('update: ONE compute per kernel per frame (all cascades batched), sizes = batch probes x texels', () => {
  const { gi, calls } = mk(); gi.configure(OPEN);
  const r = gi.update(0.016, [16, 8, 16]);
  assert.equal(calls.length, 2); assert.equal(r.mode, 'open');
  assert.equal(calls[0], r.probesDispatched * 64); assert.equal(calls[1], r.probesDispatched * 256);
  const plan = planCascadeBatches(buildCascades(OPEN.cascades), [0, 0, 0]);
  assert.equal(r.probesDispatched, plan.counts.reduce((a, b) => a + b, 0));
});
test('addMesh/removeMesh: dirty bricks rebuilt+uploaded incrementally, only changed bricks re-uploaded', () => {
  const { gi } = mk(); gi.configure(OPEN);
  let r = gi.update(0.016, [16, 8, 16]); assert.equal(r.bricksRebuilt, 16); // first frame: whole 4x2x4 window (maxBricksPerUpdate 16)
  const open = gi.resources.open; for (let i = 0; i < 4; i++) gi.update(0.016, [16, 8, 16]);
  assert.equal(open.win.dirty.size, 0);
  assert.equal(gi.addMesh('car', { triangles: quad(3.5, 1, 5, 1, 5), color: [1, 0, 0] }), true);
  r = gi.update(0.016, [16, 8, 16]); assert.equal(r.bricksRebuilt, 1);
  assert.equal(open.vs.attr.updateRanges.length, 1);
  assert.equal(gi.removeMesh('car'), true); r = gi.update(0.016, [16, 8, 16]); assert.equal(r.bricksRebuilt, 1);
  r = gi.update(0.016, [16, 8, 16]); assert.equal(r.bricksRebuilt, 0, 'idle frame uploads nothing');
});
test('driving: camera scroll marks entered probes fresh (depth sentinel written via partial ranges only)', () => {
  const { gi } = mk(); gi.configure(OPEN); const o = gi.resources.open;
  gi.update(0.016, [16, 8, 16]);
  const before = o._depthAttr.array.slice();
  const r = gi.update(0.016, [16 + 2, 8, 16]); // finest cascade (2 m) shifts one cell
  assert.equal(r.freshProbes, 3 * 16); // +2 m = one cell shift in each of the 3 cascades (2/6/18 m snap), one 4x4 YZ plane each
  assert.equal(o._depthAttr.updateRanges.length, 48); assert.ok(o._depthAttr.updateRanges.every((x) => x.count === 256 * o._depthAttr.itemSize));
  const r2 = gi.update(0.016, [18, 8, 16]); assert.equal(r2.freshProbes, 0);
});
test('RTS mode untouched: same configure call without mode builds the RTS grid, update uses the RTS path', () => {
  const { gi, calls } = mk(); gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 16, layersY: 2, heightRange: [0, 8], raysPerProbe: 8 });
  assert.ok(gi.resources.grid && !gi.resources.open); const r = gi.update(0.016, [0, 0, 0]);
  assert.ok(r.dispatched && !r.mode); assert.equal(calls.length, 2);
  assert.equal(gi.addMesh('x', { triangles: [] }), false);
});
test('switching open → disabled releases everything', () => {
  const { gi } = mk(); gi.configure(OPEN); assert.equal(gi.configure({ enabled: false }), false);
  assert.equal(gi.resources, null); assert.deepEqual(gi.update(0.016, [0, 0, 0]), { dispatched: false });
});
test('setSkySummary updates sky uniforms live', () => {
  const { gi } = mk(); gi.configure(OPEN); gi.setSkySummary({ zenith: [1, 2, 3], horizon: [4, 5, 6], ground: [7, 8, 9] });
  const s = gi.resources.open.sky; assert.deepEqual([s.zenith.value.x, s.horizon.value.y, s.ground.value.z], [1, 5, 9]);
});
test('setBatch: cumulative layout, 4-slot padded', () => {
  const b = createBatchUniforms(); const tot = setBatch(b, [5, 0, 7], [10, 20, 30]);
  assert.equal(tot, 60); assert.deepEqual([b.cumU.value.x, b.cumU.value.y, b.cumU.value.z, b.cumU.value.w], [10, 30, 60, 60]);
});
test('planCascadeBatches: cursors advance per cascade, wrap modulo count (kernel wraps)', () => {
  const cs = buildCascades(); let cur = [0, 0, 0]; const seen = cs.map(() => new Set());
  for (let i = 0; i < 16; i++) { const p = planCascadeBatches(cs, cur); cur = p.cursors; p.starts.forEach((s, k) => { for (let j = 0; j < p.counts[k]; j++) seen[k].add((s + j) % cs[k].count); }); }
  seen.forEach((s, k) => assert.equal(s.size, cs[k].count));
});
test('mutant: scroll without partial ranges → depth sentinel never uploaded (and a ranges-less needsUpdate would re-upload the WHOLE buffer)', async () => {
  const M = await loadMutant('client/kernel/gi/gi-open-controller.js', 'this._depthAttr.addUpdateRange(start, tpp * item); n++;', 'n++;');
  const { GI_DEFAULTS } = await import('../client/kernel/gi/gi-controller.js');
  const o = new M.GIOpen({ renderer: { compute() {} }, scene: new THREE.Scene(), params: { ...GI_DEFAULTS, ...M.OPEN_PARAM_DEFAULTS, ...OPEN }, attachment: null });
  o.update(0.016, [16, 8, 16]); o.update(0.016, [18, 8, 16]);
  assert.equal(o._depthAttr.updateRanges.length, 0, 'mutant: no ranges');
  assert.equal(gi_ranges(), 48, 'real code: 48 ranges');
  function gi_ranges() { const { gi } = mk(); gi.configure(OPEN); gi.update(0, [16, 8, 16]); gi.update(0, [18, 8, 16]); return gi.resources.open._depthAttr.updateRanges.length; }
});
