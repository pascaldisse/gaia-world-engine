// v2 open-world cascades (client/kernel/gi/cascade.js). Pure JS grid math + mutants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../client/kernel/gi/cascade.js';
import { loadMutant } from './helpers/mutant.js';

const cs = C.buildCascades();
const bases = (cam) => cs.map((c) => C.cascadeBaseCell(c, cam));

test('layout: 3 cascades, spacing 2/6/18, contiguous baseIndex, total = sum', () => {
  assert.deepEqual(cs.map((c) => c.spacing), [2, 6, 18]);
  assert.deepEqual(cs.map((c) => c.baseIndex), [0, 2048, 4096]);
  assert.equal(C.totalProbes(cs), 6144);
});
test('per-cascade dims honoured', () => {
  const c2 = C.buildCascades({ count: 2, spacings: [1, 4], dims: [{ x: 4, y: 2, z: 4 }, { x: 8, y: 8, z: 8 }] });
  assert.deepEqual(c2.map((c) => c.count), [32, 512]);
  assert.equal(c2[1].baseIndex, 32);
});
test('Y scrolls: camera climbing moves the window in Y (RTS mode never does)', () => {
  const a = C.cascadeBaseCell(cs[0], [0, 0, 0]);
  const b = C.cascadeBaseCell(cs[0], [0, 40, 0]);
  assert.equal(b[1] - a[1], 20);
  assert.equal(b[0], a[0]);
});
test('window snaps to whole cells: sub-cell camera motion never shifts', () => {
  const s = C.scrollCascade(cs[0], C.cascadeBaseCell(cs[0], [0.1, 0.1, 0.1]), [1.9, 1.9, 1.9]);
  assert.equal(s.shifted, false);
  assert.deepEqual(s.freshSlots, []);
});
test('toroidal: probe that stays in-window keeps its slot; only entered probes are fresh', () => {
  const c = cs[0];
  const b0 = C.cascadeBaseCell(c, [0, 0, 0]);
  const slotBefore = C.slotOfCell(c, b0[0] + 5, b0[1] + 3, b0[2] + 5);
  const s = C.scrollCascade(c, b0, [2, 0, 0]); // +1 cell in X
  assert.deepEqual(s.shift, [1, 0, 0]);
  assert.equal(C.slotOfCell(c, b0[0] + 5, b0[1] + 3, b0[2] + 5), slotBefore);
  assert.equal(s.freshSlots.length, c.dims.y * c.dims.z); // one new YZ plane
  assert.equal(new Set(s.freshSlots).size, s.freshSlots.length);
  // fresh slots' world cell is the new far plane x = base+dims.x-1
  for (const sl of s.freshSlots) assert.equal(C.cellOfSlot(c, sl, s.baseCell)[0], s.baseCell[0] + c.dims.x - 1);
});
test('cellOfSlot/slotOfCell round-trip for every slot at a negative-coordinate window', () => {
  const c = cs[1]; const base = C.cascadeBaseCell(c, [-100, -30, -77]);
  const seen = new Set();
  for (let s = 0; s < c.count; s++) { const cell = C.cellOfSlot(c, s, base); assert.equal(C.slotOfCell(c, ...cell), s); seen.add(cell.join()); }
  assert.equal(seen.size, c.count);
});
test('big teleport: all slots fresh', () => {
  const b0 = C.cascadeBaseCell(cs[0], [0, 0, 0]);
  assert.equal(C.scrollCascade(cs[0], b0, [500, 0, 500]).freshSlots.length, cs[0].count);
});
test('selection: finest cascade containing the point wins', () => {
  const B = bases([0, 0, 0]);
  assert.deepEqual(C.selectCascades(cs, B, [0, 0, 0]), [{ index: 0, weight: 1 }]);
  // 40 m away: outside cascade0 (+-14 m), inside cascade1 (+-42 m)
  const r = C.selectCascades(cs, B, [30, 0, 0]);
  assert.equal(r[0].index, 1);
  // far: only cascade 2 (+-130 m)
  assert.deepEqual(C.selectCascades(cs, B, [100, 0, 0]), [{ index: 2, weight: 1 }]);
  assert.deepEqual(C.selectCascades(cs, B, [1000, 0, 0]), []);
});
test('border blend: interior pure fine, at border pure coarse, between = 2 weights summing to 1', () => {
  const B = bases([0, 0, 0]);
  const c0 = cs[0]; const o = C.cellToWorld(B[0], c0.spacing);
  const maxX = o[0] + (c0.dims.x - 1) * c0.spacing;
  assert.deepEqual(C.selectCascades(cs, B, [0, 0, 0]), [{ index: 0, weight: 1 }]);
  const edge = C.selectCascades(cs, B, [maxX, 0, 0]);
  assert.deepEqual(edge, [{ index: 1, weight: 1 }]);
  const mid = C.selectCascades(cs, B, [maxX - 1.5 * c0.spacing * 0.5, 0, 0]);
  assert.equal(mid.length, 2);
  assert.ok(mid[0].weight > 0 && mid[0].weight < 1);
  assert.ok(Math.abs(mid[0].weight + mid[1].weight - 1) < 1e-12);
  // continuity: weights monotone toward the border
  const w = (x) => C.selectCascades(cs, B, [x, 0, 0]).find((e) => e.index === 0)?.weight ?? 0;
  assert.ok(w(maxX - 2.5) >= w(maxX - 1.5) && w(maxX - 1.5) >= w(maxX - 0.5));
});
test('round-robin budget: per-cascade batches, cursor wraps, whole cascade covered over 1/fraction calls', () => {
  let cur = [0, 0, 0]; const covered = cs.map((c) => new Set());
  for (let it = 0; it < 16; it++) {
    const p = C.planCascadeUpdate(cs, cur); cur = p.cursors;
    for (const b of p.batches) for (let s = b.start; s < b.start + b.count; s++) covered[b.cascade].add(s);
  }
  covered.forEach((set, k) => assert.equal(set.size, cs[k].count, `cascade ${k} fully covered`));
  const p1 = C.planCascadeUpdate(cs, [0, 0, 0]);
  assert.deepEqual(p1.batches.map((b) => b.count), [512, 256, 128]); // finest gets the biggest budget
});
test('round-robin wrap splits the batch in two', () => {
  const p = C.planCascadeUpdate(cs, [2040, 0, 0]);
  const b0 = p.batches.filter((b) => b.cascade === 0);
  assert.deepEqual(b0, [{ cascade: 0, start: 2040, count: 8 }, { cascade: 0, start: 0, count: 504 }]);
});
// ---- mutants: each key rule, break it, test must go red
test('mutant: coarsest-first selection -> fine-cascade test fails', async () => {
  const M = await loadMutant('client/kernel/gi/cascade.js', 'for (let k = 0; k < cascades.length; k++) {\n    if (!cascadeContains', 'for (let k = cascades.length - 1; k >= 0; k--) {\n    if (!cascadeContains');
  assert.notDeepEqual(M.selectCascades(cs, bases([0, 0, 0]), [0, 0, 0]), [{ index: 0, weight: 1 }]);
});
test('mutant: non-toroidal slots (no mod) -> in-window probe slot changes on scroll', async () => {
  const M = await loadMutant('client/kernel/gi/cascade.js', 'posMod(cx, x) + x * (posMod(cy, y) + y * posMod(cz, z))', '(cx - 0) + x * ((cy - 0) + y * (cz - 0))');
  const c = cs[0]; const b0 = M.cascadeBaseCell(c, [0, 0, 0]);
  // slots out of [0,count) once coordinates go negative/large
  assert.ok(M.slotOfCell(c, -5, 0, 0) < 0, 'mutant escapes the slot range');
  assert.ok(C.slotOfCell(c, -5, 0, 0) >= 0);
});
test('mutant: Y pinned (RTS-style) -> climbing no longer moves the window', async () => {
  const M = await loadMutant('client/kernel/gi/cascade.js', 'Math.floor(cameraPos[1] / spacing)', '0');
  assert.equal(M.cascadeBaseCell(cs[0], [0, 40, 0])[1], M.cascadeBaseCell(cs[0], [0, 0, 0])[1]);
});
test('mutant: no blend (hard switch) -> mid-border weight is not fractional', async () => {
  const M = await loadMutant('client/kernel/gi/cascade.js', 'return wFine <= 0 ? [{ index: k + 1, weight: 1 }] : [{ index: k, weight: wFine }, { index: k + 1, weight: 1 - wFine }];', 'return [{ index: k, weight: 1 }];');
  const B = bases([0, 0, 0]); const c0 = cs[0]; const o = C.cellToWorld(B[0], c0.spacing);
  const x = o[0] + (c0.dims.x - 1) * c0.spacing - 0.75;
  assert.equal(M.selectCascades(cs, B, [x, 0, 0]).length, 1);
  assert.equal(C.selectCascades(cs, B, [x, 0, 0]).length, 2);
});
