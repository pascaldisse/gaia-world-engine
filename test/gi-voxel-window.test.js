// v2 incremental voxelization (voxel-window.js): registry, brick dirtiness, albedo, partial uploads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VoxelWindow, packVoxel, unpackAlbedo, isSolid, extractMeshTriangles } from '../client/kernel/gi/voxel-window.js';
import { loadMutant } from './helpers/mutant.js';

// flat quad (2 tris) at height y spanning [x0,x1]x[z0,z1]
const quadY = (y, x0, x1, z0, z1) => [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
// wall quad at x = x, spanning y,z
const wallX = (x, y0, y1, z0, z1) => [x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z0, x, y1, z1, x, y0, z1];
const small = () => new VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); // 32x16x32 voxels @1m

test('pack/unpack albedo round-trips (8-bit), solid bit set, 0 = empty', () => {
  const v = packVoxel([1, 0.5, 0]); assert.ok(isSolid(v)); assert.ok(!isSolid(0));
  const a = unpackAlbedo(v); assert.ok(Math.abs(a[0] - 1) < 1e-9 && Math.abs(a[1] - 0.5) < 0.005 && a[2] === 0);
});
test('addMesh marks ONLY overlapped bricks dirty; update rebuilds them; one partial range per brick', () => {
  const w = small(); w.setCenter([16, 8, 16]); w.update(1000); // settle initial
  assert.equal(w.dirty.size, 0);
  w.addMesh('a', { triangles: quadY(3.5, 1, 5, 1, 5), color: [1, 0, 0] }); // inside brick (0,0,0)-ish
  assert.equal(w.dirty.size, 1);
  const r = w.update();
  assert.equal(r.rebuilt.length, 1); assert.equal(r.rebuilt[0].count, 512); assert.equal(r.remaining, 0);
  assert.equal(r.rebuilt[0].start % 512, 0);
  assert.ok(isSolid(w.getVoxelAtWorld([2, 3.5, 2])));
  assert.ok(!isSolid(w.getVoxelAtWorld([2, 5.5, 2])));
});
test('mesh spanning several bricks dirties each; untouched far brick stays clean', () => {
  const w = small(); w.setCenter([16, 8, 16]); w.update(1000);
  w.addMesh('road', { triangles: quadY(2.5, 0, 20, 0, 3), color: [0.3, 0.3, 0.3] });
  assert.equal(w.dirty.size, 3); // bricks x=0,1,2 (8 m) , z=0, y=0
  w.update(1000);
  assert.ok(isSolid(w.getVoxelAtWorld([19, 2.5, 1])));
  assert.ok(!isSolid(w.getVoxelAtWorld([25, 2.5, 1])));
});
test('removeMesh re-dirties the same bricks and clears the voxels', () => {
  const w = small(); w.setCenter([16, 8, 16]);
  w.addMesh('a', { triangles: quadY(3.5, 1, 5, 1, 5) }); w.update(1000);
  assert.ok(isSolid(w.getVoxelAtWorld([2, 3.5, 2])));
  assert.equal(w.removeMesh('a'), true); assert.ok(w.dirty.size >= 1);
  w.update(1000); assert.ok(!isSolid(w.getVoxelAtWorld([2, 3.5, 2])));
  assert.equal(w.removeMesh('nope'), false);
});
test('per-frame budget: update(max) rebuilds at most max bricks, remaining reported', () => {
  const w = small(); w.setCenter([16, 8, 16]); w.update(1000);
  w.addMesh('big', { triangles: quadY(3.5, 0, 30, 0, 30) });
  const n = w.dirty.size; assert.ok(n > 4);
  const r = w.update(4); assert.equal(r.rebuilt.length, 4); assert.equal(r.remaining, n - 4);
});
test('albedo: avg material colour x texture mean; overlapping meshes average', () => {
  const w = small(); w.setCenter([16, 8, 16]);
  w.addMesh('red', { triangles: quadY(3.5, 1, 5, 1, 5), color: [1, 1, 1], textureMean: [0.8, 0.2, 0.2] });
  w.update(1000);
  const a = unpackAlbedo(w.getVoxelAtWorld([2, 3.5, 2]));
  assert.ok(Math.abs(a[0] - 0.8) < 0.01 && Math.abs(a[1] - 0.2) < 0.01);
  w.addMesh('blue', { triangles: quadY(3.5, 1, 5, 1, 5), albedo: [0.2, 0.2, 0.8] }); w.update(1000);
  const m = unpackAlbedo(w.getVoxelAtWorld([2, 3.5, 2]));
  assert.ok(Math.abs(m[0] - 0.5) < 0.01 && Math.abs(m[2] - 0.5) < 0.01);
});
test('window scroll (toroidal): only entering bricks dirty; retained bricks keep data without rebuild', () => {
  const w = small(); w.setCenter([16, 8, 16]);
  w.addMesh('a', { triangles: quadY(3.5, 17, 21, 17, 21), color: [1, 0, 0] }); w.update(1000);
  const entered = w.setCenter([16 + 8, 8, 16]); // +1 brick in X
  assert.equal(entered, 1 * 2 * 4);
  assert.equal(w.dirty.size, 8);
  assert.ok(isSolid(w.getVoxelAtWorld([18, 3.5, 18])), 'retained brick data intact before any update');
  w.update(1000);
  assert.ok(isSolid(w.getVoxelAtWorld([18, 3.5, 18])));
  assert.equal(w.getVoxelAtWorld([-100, 0, 0]), 0, 'outside window reads empty');
});
test('mesh outside the window never dirties anything', () => {
  const w = small(); w.setCenter([16, 8, 16]); w.update(1000);
  w.addMesh('far', { triangles: quadY(3.5, 900, 910, 900, 910) }); assert.equal(w.dirty.size, 0);
});
test('plane test: a diagonal wall is thin (AABB-only would fill the whole box)', () => {
  const w = new VoxelWindow({ bricks: { x: 2, y: 2, z: 2 } }); w.setCenter([8, 8, 8]);
  // vertical diagonal wall in XZ from (0,0) to (14,14), height 0..6
  w.addMesh('d', { triangles: [0, 0, 0, 14, 0, 14, 14, 6, 14, 0, 0, 0, 14, 6, 14, 0, 6, 0] }); w.update(1000);
  let solid = 0; for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (isSolid(w.getVoxel(x, 2, z))) solid++;
  assert.ok(solid > 8 && solid < 60, `diagonal slice ${solid} voxels (AABB fill would be ~196)`);
  assert.ok(!isSolid(w.getVoxel(14, 2, 1)), 'far corner off the wall plane stays empty');
});
test('extractMeshTriangles: three Mesh world transform + material colour', () => {
  const g = new THREE.BoxGeometry(2, 2, 2); const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const m = new THREE.Mesh(g, mat); m.position.set(10, 4, 10); m.updateMatrixWorld(true);
  const e = extractMeshTriangles(m); assert.equal(e.triangles.length, 36 * 3);
  assert.ok(Math.abs(Math.min(...e.triangles.filter((_, i) => i % 3 === 0)) - 9) < 1e-5);
  const w = small(); w.setCenter([16, 8, 16]); w.addMesh('box', e); w.update(1000);
  assert.ok(isSolid(w.getVoxelAtWorld([10, 4, 10])) || isSolid(w.getVoxelAtWorld([10, 5, 10])));
  assert.ok(unpackAlbedo(w.getVoxelAtWorld([9.5, 4.5, 10]))[0] > 0.9);
});
// ---- mutants
test('mutant: removeMesh forgets to re-dirty -> stale voxels survive', async () => {
  const M = await loadMutant('client/kernel/gi/voxel-window.js', 'this.meshes.delete(id); this._markAabb(m.aabb); return true;', 'this.meshes.delete(id); return true;');
  const w = new M.VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); w.setCenter([16, 8, 16]);
  w.addMesh('a', { triangles: quadY(3.5, 1, 5, 1, 5) }); w.update(1000); w.removeMesh('a'); w.update(1000);
  assert.ok(M.isSolid(w.getVoxelAtWorld([2, 3.5, 2])), 'mutant leaves ghost geometry');
});
test('mutant: addMesh marks no bricks -> mesh never voxelizes', async () => {
  const M = await loadMutant('client/kernel/gi/voxel-window.js', 'this.meshes.set(id, { tri, aabb, albedo: meshAlbedo(mesh) });\n    this._markAabb(aabb);', 'this.meshes.set(id, { tri, aabb, albedo: meshAlbedo(mesh) });');
  const w = new M.VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); w.setCenter([16, 8, 16]); w.update(1000);
  w.addMesh('a', { triangles: quadY(3.5, 1, 5, 1, 5) }); assert.equal(w.dirty.size, 0);
});
test('mutant: albedo ignored (flat) -> red wall not red', async () => {
  const M = await loadMutant('client/kernel/gi/voxel-window.js', 'const t = textureMean ?? [1, 1, 1];\n  return [color[0] * t[0], color[1] * t[1], color[2] * t[2]];', 'return [0.5, 0.5, 0.5];');
  const w = new M.VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); w.setCenter([16, 8, 16]);
  w.addMesh('r', { triangles: quadY(3.5, 1, 5, 1, 5), color: [1, 0, 0] }); w.update(1000);
  assert.ok(M.unpackAlbedo(w.getVoxelAtWorld([2, 3.5, 2]))[0] < 0.6);
});
test('mutant: no plane test -> diagonal wall over-fills', async () => {
  const M = await loadMutant('client/kernel/gi/voxel-window.js', 'if (planar) {\n            const dx', 'if (false) {\n            const dx');
  const w = new M.VoxelWindow({ bricks: { x: 2, y: 2, z: 2 } }); w.setCenter([8, 8, 8]);
  w.addMesh('d', { triangles: [0, 0, 0, 14, 0, 14, 14, 6, 14, 0, 0, 0, 14, 6, 14, 0, 6, 0] }); w.update(1000);
  assert.ok(M.isSolid(w.getVoxel(14, 2, 1)), 'AABB fill marks the far corner');
});
