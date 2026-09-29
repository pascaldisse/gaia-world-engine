// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §16 #3-#12 (+ §3.4 closure, §3.7 conservation, purity §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fractureCells } from '../client/extensions/rayfire/fracture.js';
import { closeOpenShell } from '../client/extensions/rayfire/closure.js';
import { facesVolume, isWatertight, meshVolume } from '../client/extensions/rayfire/geometry.js';
import { boxTriangles, openBottomBox, lPrism, deepFreeze, roundDeep, V } from './helpers/rayfire-fixtures.js';

const BOX2 = () => boxTriangles(V(-1, -1, -1), V(1, 1, 1));
const sumVol = cells => cells.reduce((s, c) => s + Math.abs(facesVolume(c.faces)), 0);

test('#3 2x2x2 box, ~20 fragments: sum |cell volume| = 8 within 1e-6 (exact partition)', () => {
  for (const seed of [1, 7, 42]) {
    const cells = fractureCells(BOX2(), { amount: 20, seed });
    assert.ok(cells.length > 10, `expected many cells, got ${cells.length}`);
    assert.ok(Math.abs(sumVol(cells) - 8) / 8 < 1e-6, `seed ${seed}: sum=${sumVol(cells)}`);
  }
});

test('#4 every box cell is watertight, positive volume, flags surfaced', () => {
  const cells = fractureCells(BOX2(), { amount: 20, seed: 3 });
  for (const c of cells) {
    assert.equal(isWatertight(c.faces), true);
    assert.ok(facesVolume(c.faces) > 0);
    assert.equal(typeof c.uncappedLoops, 'boolean');
    assert.equal(c.hullFallback, false, 'closed convex source must never need the hull last resort');
    assert.ok(Number.isInteger(c.index));
    assert.ok(c.seedPoint && Number.isFinite(c.seedPoint.x));
  }
});

test('#5 same (mesh, seed) twice -> identical after rounding; input never mutated (purity §15)', () => {
  const src = deepFreeze(BOX2());
  const a = fractureCells(src, { amount: 12, seed: 9 });
  const b = fractureCells(src, { amount: 12, seed: 9 });
  assert.equal(roundDeep(a), roundDeep(b));
});

test('#6 different seeds -> different cell sets (seed-ignoring stub discriminator)', () => {
  const a = fractureCells(BOX2(), { amount: 12, seed: 1 });
  const b = fractureCells(BOX2(), { amount: 12, seed: 2 });
  assert.notEqual(roundDeep(a), roundDeep(b));
  // seed is uint32-coerced: -1 == 4294967295
  assert.equal(roundDeep(fractureCells(BOX2(), { amount: 6, seed: -1 })), roundDeep(fractureCells(BOX2(), { amount: 6, seed: 4294967295 })));
});

test('#7 fracture yields interior(cut) faces with interior material AND exterior faces with exterior material', () => {
  const cells = fractureCells(BOX2(), { amount: 10, seed: 5 });
  const faces = cells.flatMap(c => c.faces);
  assert.ok(faces.some(f => f.interior === true && f.materialId === 1));
  assert.ok(faces.some(f => f.interior === false && f.materialId === 0));
  assert.ok(faces.every(f => (f.interior ? f.materialId === 1 : f.materialId === 0)));
  const custom = fractureCells(BOX2(), { amount: 4, seed: 5, interiorMaterial: 7 }).flatMap(c => c.faces);
  assert.ok(custom.some(f => f.interior && f.materialId === 7));
  assert.ok(faces.every(f => Array.isArray(f.verts) && f.verts.length >= 3));
});

test('#8 amount=1 -> exactly one cell, no interior faces, volume = whole source (no spurious cutting)', () => {
  const cells = fractureCells(BOX2(), { amount: 1, seed: 4 });
  assert.equal(cells.length, 1);
  assert.equal(cells[0].faces.some(f => f.interior), false);
  assert.ok(Math.abs(facesVolume(cells[0].faces) - 8) < 1e-9);
});

test('#9 strong contact bias toward a corner: big far-side cell dominates, near side is finer', () => {
  const corner = V(-1, -1, -1);
  const opts = { amount: 20, seed: 3 };
  const un = fractureCells(BOX2(), opts);
  const bi = fractureCells(BOX2(), { ...opts, bias: 0.9, biasPoint: corner });
  const share = cs => Math.max(...cs.map(c => facesVolume(c.faces))) / 8;
  assert.ok(share(bi) > 2 * share(un), `biased max share ${share(bi)} vs unbiased ${share(un)}`);
  const cd = c => { const vs = c.faces.flatMap(f => f.verts); const m = vs.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 }); const n = vs.length; return Math.hypot(m.x / n - corner.x, m.y / n - corner.y, m.z / n - corner.z); };
  const big = bi.reduce((a, c) => (facesVolume(c.faces) > facesVolume(a.faces) ? c : a));
  const med = bi.map(cd).sort((a, b) => a - b)[bi.length >> 1];
  assert.ok(cd(big) > med, 'dominant cell sits on the far side');
  // monotonic: bias 0 == no bias
  assert.equal(roundDeep(fractureCells(BOX2(), { ...opts, bias: 0, biasPoint: corner })), roundDeep(un));
});

test('amount variation is seeded and jitters count; default variation 0 = exact requested count (≤ cells)', () => {
  const exact = fractureCells(BOX2(), { amount: 8, seed: 2 });
  assert.ok(exact.length <= 8 && exact.length >= 6);
  const a = fractureCells(BOX2(), { amount: 20, seed: 2, variation: 50 });
  const b = fractureCells(BOX2(), { amount: 20, seed: 2, variation: 50 });
  assert.equal(a.length, b.length);
  const counts = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(s => fractureCells(BOX2(), { amount: 20, seed: s, variation: 50 }).length));
  assert.ok(counts.size > 1, 'variation must move the count across seeds');
  for (const s of [1, 2, 3]) assert.ok(fractureCells(BOX2(), { amount: 5, seed: s }).length <= 5, 'never more cells than requested seeds');
});

test('#10 OPEN-SHELL (missing bottom): every fragment watertight + positive volume; pre-close flag semantics', () => {
  const shell = openBottomBox(V(-1, 0, -1), V(1, 2, 1), 2);
  assert.equal(isWatertight(shell), false, 'fixture must actually be open');
  const cells = fractureCells(shell, { amount: 14, seed: 11 });
  assert.ok(cells.length > 5);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); }
  // conservation is asserted against the pre-closed PROXY (8 = 2*2*2 after capping the bottom)
  assert.ok(Math.abs(sumVol(cells) - 8) / 8 < 1e-6, `sum=${sumVol(cells)}`);
  // the pre-close cap is a cut-like face: tagged interior
  assert.ok(cells.some(c => c.faces.some(f => f.interior)));
});

test('#10b nasty open shell: hole in a wall + duplicate tri + degenerate tri + T-junction-ish split, still guaranteed watertight', () => {
  let t = boxTriangles(V(0, 0, 0), V(2, 2, 2), 3);
  t = t.filter((_, i) => i !== 5 && i !== 17);                    // punch two holes
  t.push(t[0], [V(1, 1, 1), V(1, 1, 1), V(2, 2, 2)]);             // duplicate + degenerate
  const [a, b, c] = t[7]; const m = V((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  t[7] = [a, m, c];                                                // splits one edge -> T-junction against its neighbour
  const cells = fractureCells(t, { amount: 16, seed: 21 });
  assert.ok(cells.length > 0);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); }
});

test('#10c inverted (inward-wound) closed source still yields positive-volume watertight cells', () => {
  const inv = boxTriangles(V(0, 0, 0), V(2, 2, 2)).map(([a, b, c]) => [a, c, b]);
  const cells = fractureCells(inv, { amount: 10, seed: 2 });
  assert.ok(cells.length > 3);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); }
  assert.ok(Math.abs(sumVol(cells) - 8) / 8 < 1e-6);
});

test('concave L prism: cells watertight, positive, volume conserved (multi-loop caps)', () => {
  const cells = fractureCells(lPrism(1), { amount: 16, seed: 8 });
  assert.ok(cells.length > 4);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); }
  assert.ok(Math.abs(sumVol(cells) - 3) / 3 < 1e-6, `sum=${sumVol(cells)}`);
});

test('#11 zero-thickness double-sided sheet: NO zero/negative-volume cell is ever returned', () => {
  const s = 5;
  const q = [V(0, 0, 0), V(s, 0, 0), V(s, s, 0), V(0, s, 0)];
  const front = [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
  const back = front.map(([a, b, c]) => [a, c, b]);
  const cells = fractureCells([...front, ...back], { amount: 10, seed: 3 });
  for (const c of cells) assert.ok(facesVolume(c.faces) > 0, 'zero-volume sliver returned');
  // and a merely thin slab keeps its positive cells
  const thin = fractureCells(boxTriangles(V(0, 0, 0), V(10, 10, 0.001)), { amount: 10, seed: 3 });
  assert.ok(thin.length > 3);
  for (const c of thin) assert.ok(facesVolume(c.faces) > 0);
});

test('#12 ~2k-tri mesh at amount 30: >1 cell, volume conserved <1e-6, timing reported', () => {
  const mesh = boxTriangles(V(0, 0, 0), V(3, 2, 1), 13);
  assert.ok(mesh.length >= 2000);
  const t0 = performance.now();
  const cells = fractureCells(mesh, { amount: 30, seed: 5 });
  const ms = performance.now() - t0;
  console.log(`# #12 ${mesh.length} tris, amount 30 -> ${cells.length} cells in ${ms.toFixed(1)} ms`);
  assert.ok(cells.length > 1);
  assert.ok(Math.abs(sumVol(cells) - 6) / 6 < 1e-6);
  assert.ok(ms < 2000, 'sanity budget (spec §15 reference ~75ms; asserted loosely, reported)');
});

test('closeOpenShell: no-op on closed mesh; caps a bottom loop with interior faces; flags non-cappable', () => {
  const closed = closeOpenShell(boxTriangles());
  assert.equal(closed.capped, 0);
  assert.equal(closed.uncappedLoops, false);
  assert.equal(isWatertight(closed.faces), true);
  const open = closeOpenShell(openBottomBox(V(0, 0, 0), V(1, 1, 1)));
  assert.ok(open.capped >= 1);
  assert.equal(isWatertight(open.faces), true);
  assert.ok(open.faces.some(f => f.interior));
  assert.ok(Math.abs(facesVolume(open.faces) - 1) < 1e-9);
});

test('purity: fractureCells has no hidden state (call order / interleaving irrelevant)', () => {
  const a1 = roundDeep(fractureCells(BOX2(), { amount: 9, seed: 1 }));
  fractureCells(boxTriangles(), { amount: 30, seed: 99 });
  const a2 = roundDeep(fractureCells(BOX2(), { amount: 9, seed: 1 }));
  assert.equal(a1, a2);
  assert.ok(meshVolume(BOX2()) > 0);
});

test('mixed part: solid box + a loose flat sheet (real-asset pattern) -> sheet ignored, box conserved, no hull fallback', () => {
  const sheet = [[V(3, 0, 0.5), V(5, 0, 0.5), V(5, 2, 0.5)], [V(3, 0, 0.5), V(5, 2, 0.5), V(3, 2, 0.5)]];
  const cells = fractureCells([...boxTriangles(V(0, 0, 0), V(2, 2, 2)), ...sheet], { amount: 12, seed: 4 });
  assert.ok(cells.length > 4);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); assert.equal(c.hullFallback, false); }
  assert.ok(Math.abs(sumVol(cells) - 8) / 8 < 1e-6);
  // a source made ONLY of a flat sheet has no volume -> no fragments, no throw
  assert.deepEqual(fractureCells(sheet, { amount: 6, seed: 4 }), []);
});

test('empty / degenerate-only input -> [] (no throw)', () => {
  assert.deepEqual(fractureCells([], { amount: 5 }), []);
  assert.deepEqual(fractureCells([[V(0, 0, 0), V(0, 0, 0), V(1, 1, 1)]], { amount: 5 }), []);
});
