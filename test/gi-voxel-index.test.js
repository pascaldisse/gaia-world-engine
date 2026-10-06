// CC-GIVOX: VoxelWindow brick-keyed mesh index == linear scan (bit-identical voxels), incl. add/remove churn, big meshes, brick-boundary touching AABBs, scroll.
import { describe, test, expect } from 'bun:test';
import { VoxelWindow } from '../client/kernel/gi/voxel-window.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function randMesh(r, span, big) {
  const n = 1 + Math.floor(r() * 12); const tri = new Float32Array(n * 9); const ox = r() * span, oy = r() * 30, oz = r() * span; const sz = big ? 120 : 2 + r() * 12;
  for (let i = 0; i < n * 9; i += 3) { tri[i] = ox + r() * sz; tri[i + 1] = oy + r() * (big ? 3 : sz); tri[i + 2] = oz + r() * sz; }
  // snap some verts onto exact brick boundaries (touching AABBs)
  if (r() < 0.3) for (let i = 0; i < tri.length; i += 3) if (r() < 0.4) tri[i] = Math.round(tri[i] / 8) * 8;
  return { triangles: tri, albedo: [r(), r(), r()] };
}
function drive(index, seed) {
  const w = new VoxelWindow({ bricks: { x: 6, y: 3, z: 6 }, index, indexMaxBricks: 64 }); const r = rng(seed); const ids = [];
  for (let i = 0; i < 160; i++) { w.addMesh('m' + i, randMesh(r, 200, i % 40 === 0)); ids.push('m' + i); }
  const log = [];
  for (let step = 0; step < 12; step++) {
    w.setCenter([step * 11, 10, step * 7]);
    if (step % 3 === 1) for (let k = 0; k < 8; k++) { const id = ids[Math.floor(r() * ids.length)]; w.removeMesh(id); }
    if (step % 3 === 2) for (let k = 0; k < 6; k++) { const id = 'n' + step + '_' + k; w.addMesh(id, randMesh(r, 200, false)); ids.push(id); }
    w.update(40);
    log.push(w.data.slice());
  }
  while (w.dirty.size) w.update(1000);
  log.push(w.data.slice());
  return { log, scan: w.scan };
}
describe('VoxelWindow index', () => {
  test('indexed == linear, bit-identical over churn + scroll', () => {
    for (const seed of [1, 2, 3]) {
      const a = drive(false, seed), b = drive(true, seed);
      expect(b.log.length).toBe(a.log.length);
      for (let i = 0; i < a.log.length; i++) expect(Buffer.compare(Buffer.from(b.log[i].buffer), Buffer.from(a.log[i].buffer))).toBe(0);
      expect(b.scan.bricks).toBe(a.scan.bricks);
      expect(b.scan.meshesScanned).toBeLessThan(a.scan.meshesScanned); // O(candidates)
    }
  });
  test('index is empty after removing everything; default off', () => {
    const w = new VoxelWindow({ index: true }); expect(new VoxelWindow().indexOn).toBe(false);
    w.addMesh('a', { triangles: [0, 0, 0, 1, 0, 0, 0, 1, 0] }); w.addMesh('b', { triangles: [0, 0, 0, 500, 0, 0, 0, 500, 0] });
    expect(w.cells.size > 0 && w.big.size === 1).toBe(true); w.removeMesh('a'); w.removeMesh('b');
    expect(w.cells.size).toBe(0); expect(w.big.size).toBe(0);
  });
});
