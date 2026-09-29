// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §3.4 closure ladder: loop chaining, cap triangulation, hull last resort, sliver hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capPolygons, chainLoops, closeBoundaries } from '../client/extensions/rayfire/closure.js';
import { hullFaces, HULL_WELD_LADDER, _boxFacesForTest } from '../client/extensions/rayfire/hull.js';
import { fractureCells } from '../client/extensions/rayfire/fracture.js';
import { facesVolume, isWatertight, toTriangles } from '../client/extensions/rayfire/geometry.js';
import { boxTriangles, V } from './helpers/rayfire-fixtures.js';

const area = polys => polys.reduce((s, p) => { let x = 0, y = 0, z = 0; for (let i = 1; i < p.length - 1; i++) { const a = p[0], b = p[i], c = p[i + 1]; const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z; x += uy * vz - uz * vy; y += uz * vx - ux * vz; z += ux * vy - uy * vx; } return s + Math.hypot(x, y, z) / 2; }, 0);

test('capPolygons: convex planar loop -> ONE polygon; keeps loop order', () => {
  const loop = [V(0, 0, 0), V(2, 0, 0), V(2, 2, 0), V(0, 2, 0)];
  const polys = capPolygons(loop);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].length, 4);
  assert.ok(Math.abs(area(polys) - 4) < 1e-12);
});

test('capPolygons: concave (L) planar loop -> ear-clipped triangles, exact area, all winding same way', () => {
  const loop = [V(0, 0, 0), V(2, 0, 0), V(2, 1, 0), V(1, 1, 0), V(1, 2, 0), V(0, 2, 0)];
  const polys = capPolygons(loop);
  assert.ok(polys.length >= 4 && polys.every(p => p.length === 3));
  assert.ok(Math.abs(area(polys) - 3) < 1e-12);
  for (const p of polys) assert.ok((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x) >= -1e-12, 'no flipped ear');
  // perimeter edges present exactly once, diagonals cancel -> closed with the reverse loop
  const rev = loop.slice().reverse();
  assert.equal(isWatertight([...polys, rev]), true);
});

test('capPolygons: non-planar loop and collinear loop fall back to an edge-exact centroid fan', () => {
  const np = [V(0, 0, 0), V(1, 0, 0), V(1, 1, 0.5), V(0, 1, 0)];
  const p1 = capPolygons(np);
  assert.equal(isWatertight([...p1, np.slice().reverse()]), true);
  const col = [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0)];
  assert.ok(capPolygons(col).length >= 1);
  assert.deepEqual(capPolygons([V(0, 0, 0), V(1, 0, 0)]), [], 'a 2-point loop needs no cap');
});

test('chainLoops: two separate loops; figure-eight is split at the shared vertex; dead end reported', () => {
  const E = (a, b) => ({ a, b });
  const A = V(0, 0, 0), B = V(1, 0, 0), C = V(1, 1, 0), D = V(2, 1, 0), F = V(2, 2, 0), G = V(1, 2, 0);
  const two = chainLoops([E(A, B), E(B, C), E(C, A), E(D, F), E(F, G), E(G, D)]);
  assert.equal(two.loops.length, 2); assert.equal(two.dangling, 0);
  const eight = chainLoops([E(A, B), E(B, C), E(C, D), E(D, F), E(F, C), E(C, A)]);
  assert.equal(eight.loops.length, 2);
  assert.equal(eight.dangling, 0);
  const open = chainLoops([E(A, B), E(B, C)]);
  assert.equal(open.loops.length, 0);
  assert.ok(open.dangling > 0);
});

test('closeBoundaries: no-op on closed set; caps a removed face; reports uncappable rim', () => {
  const faces = boxTriangles().map(t => ({ verts: t, interior: false, materialId: 0 }));
  assert.equal(closeBoundaries(faces).capped, 0);
  const holed = faces.slice(2);
  const r = closeBoundaries(holed);
  assert.equal(isWatertight(r.faces), true);
  assert.equal(r.uncapped, false);
  assert.ok(Math.abs(facesVolume(r.faces) - 1) < 1e-9);
  const lone = closeBoundaries([{ verts: [V(0, 0, 0), V(1, 0, 0), V(0, 1, 0)], interior: false, materialId: 0 }]);
  assert.equal(isWatertight(lone.faces), true, 'a lone triangle is closable by its own reverse cap');
});

test('hull: point cloud -> watertight positive-volume triangles; exterior tag = ALL 3 verts exterior', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push({ x: Math.sin(i * 12.9) * 3, y: Math.cos(i * 7.7) * 2, z: Math.sin(i * 3.1), exterior: i % 3 !== 0 });
  const { faces, boxed } = hullFaces(pts);
  assert.equal(boxed, false);
  assert.equal(isWatertight(faces), true);
  assert.ok(facesVolume(faces) > 0);
  const ext = new Set(pts.filter(p => p.exterior).map(p => `${p.x},${p.y},${p.z}`));
  for (const f of faces) {
    const all = f.verts.every(v => ext.has(`${v.x},${v.y},${v.z}`));
    assert.equal(f.interior, !all);
    assert.equal(f.materialId, all ? 0 : 1);
  }
});

test('hull sliver hardening: float-noisy near-duplicate points still yield a watertight hull', () => {
  const pts = [];
  const cube = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  let s = 1;
  for (const c of cube) for (let k = 0; k < 6; k++) { s = (s * 16807) % 2147483647; const n = (s / 2147483647 - 0.5) * 2e-7; pts.push({ x: c[0] + n, y: c[1] - n, z: c[2] + n * 0.5, exterior: true }); }
  const { faces, boxed } = hullFaces(pts);
  assert.equal(isWatertight(faces), true);
  assert.ok(Math.abs(facesVolume(faces) - 1) < 1e-3);
  assert.equal(boxed, false);
});

test('hull absolute fallback: coplanar / too-few points -> padded AABB box, watertight, positive volume', () => {
  const flat = []; for (let i = 0; i < 10; i++) flat.push({ x: i, y: (i * 7) % 5, z: 0, exterior: true });
  const a = hullFaces(flat);
  assert.equal(a.boxed, true);
  assert.equal(isWatertight(a.faces), true);
  assert.ok(facesVolume(a.faces) > 0);
  const b = hullFaces([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }]);
  assert.equal(b.boxed, true);
  assert.equal(isWatertight(_boxFacesForTest([{ x: 0, y: 0, z: 0 }], 0, 1)), true);
  assert.deepEqual([...HULL_WELD_LADDER], [1e-5, 1e-4, 3e-4, 1e-3, 1e-2, 1e-1]);
});

test('non-manifold source (two boxes sharing an edge): every returned cell STILL watertight+positive (ladder ≤ hull)', () => {
  const a = boxTriangles(V(0, 0, 0), V(1, 1, 1)), b = boxTriangles(V(1, 1, 0), V(2, 2, 1)); // touch along the x=1,y=1 edge
  const cells = fractureCells([...a, ...b], { amount: 8, seed: 5 });
  assert.ok(cells.length > 0);
  for (const c of cells) { assert.equal(isWatertight(c.faces), true); assert.ok(facesVolume(c.faces) > 0); assert.equal(typeof c.hullFallback, 'boolean'); }
  assert.ok(toTriangles(cells[0].faces).length > 0);
});
