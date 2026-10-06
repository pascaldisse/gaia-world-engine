// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §16 #13-16 (+ §4 render conversion). Real three r180.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { facesToBufferGeometry, geometryToTriangles, fracture } from '../client/extensions/rayfire/render.js';
import { fractureCells } from '../client/extensions/rayfire/fracture.js';
import { meshVolume } from '../client/extensions/rayfire/geometry.js';
import { boxTriangles, V } from './helpers/rayfire-fixtures.js';

const faceOf = (verts, interior = false) => ({ verts, interior, materialId: interior ? 1 : 0 });

test('#13 THREE is the expected major revision; BoxGeometry round-trips to 12 numeric triangles', () => {
  assert.equal(THREE.REVISION, '180');
  const tris = geometryToTriangles(new THREE.BoxGeometry(1, 1, 1));
  assert.equal(tris.length, 12);
  for (const t of tris) { assert.equal(t.length, 3); for (const p of t) for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(p[k]), `${k} not numeric`); }
  // plain objects, not THREE vectors
  assert.equal(tris[0][0].isVector3, undefined);
  // volume of the round-tripped box = 1 (winding survives)
  assert.ok(Math.abs(meshVolume(tris) - 1) < 1e-6);
});

test('geometryToTriangles: non-indexed geometry, and indexed (Uint16/Uint32) alike', () => {
  const ni = new THREE.BoxGeometry(1, 2, 3).toNonIndexed();
  assert.equal(geometryToTriangles(ni).length, 12);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex(new THREE.Uint32BufferAttribute([0, 1, 2, 2, 1, 3], 1));
  const t = geometryToTriangles(g);
  assert.equal(t.length, 2);
  assert.deepEqual(t[1][2], { x: 1, y: 1, z: 0 });
  assert.deepEqual(geometryToTriangles(new THREE.BufferGeometry()), []);
});

test('facesToBufferGeometry: position+normal, count%3==0, exactly two groups (0=exterior mat0, 1=interior mat1), bounds', () => {
  const box = boxTriangles();
  const faces = box.map((t, i) => faceOf(t, i % 3 === 0));
  const g = facesToBufferGeometry(faces);
  assert.ok(g.isBufferGeometry);
  assert.equal(g.index, null, 'non-indexed soup');
  assert.equal(g.attributes.position.count, 36);
  assert.equal(g.attributes.normal.count, 36);
  assert.equal(g.attributes.position.count % 3, 0);
  assert.equal(g.groups.length, 2);
  const [g0, g1] = g.groups;
  assert.deepEqual([g0.materialIndex, g1.materialIndex], [0, 1]);
  assert.equal(g0.start, 0);
  assert.equal(g0.count + g1.count, 36);
  assert.equal(g0.count, 3 * box.filter((_, i) => i % 3 !== 0).length);
  assert.equal(g1.start, g0.count);
  assert.ok(g.boundingBox && g.boundingSphere);
  assert.deepEqual(g.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(g.boundingBox.max.toArray(), [1, 1, 1]);
});

test('facesToBufferGeometry: exterior-only faces -> ONE group; polygons (quads) fan-triangulated; empty ok', () => {
  const quad = faceOf([V(0, 0, 0), V(1, 0, 0), V(1, 1, 0), V(0, 1, 0)]);
  const g = facesToBufferGeometry([quad]);
  assert.equal(g.attributes.position.count, 6);
  assert.equal(g.groups.length, 1);
  assert.deepEqual([g.groups[0].start, g.groups[0].count, g.groups[0].materialIndex], [0, 6, 0]);
  assert.equal(facesToBufferGeometry([]).attributes.position.count, 0);
});

test('facesToBufferGeometry: FLAT per-triangle unit normals, perpendicular to the triangle, pointing outward', () => {
  const g = facesToBufferGeometry(boxTriangles(V(-1, -1, -1), V(1, 1, 1)).map(t => faceOf(t, false)));
  const P = g.attributes.position, N = g.attributes.normal;
  for (let t = 0; t < P.count; t += 3) {
    const n0 = [N.getX(t), N.getY(t), N.getZ(t)];
    for (let k = 1; k < 3; k++) assert.deepEqual([N.getX(t + k), N.getY(t + k), N.getZ(t + k)], n0, 'normals differ inside one triangle');
    assert.ok(Math.abs(Math.hypot(...n0) - 1) < 1e-6);
    const c = new THREE.Vector3((P.getX(t) + P.getX(t + 1) + P.getX(t + 2)) / 3, (P.getY(t) + P.getY(t + 1) + P.getY(t + 2)) / 3, (P.getZ(t) + P.getZ(t + 1) + P.getZ(t + 2)) / 3);
    assert.ok(c.dot(new THREE.Vector3(...n0)) > 0, 'normal must point away from the box centre');
    const e1 = new THREE.Vector3(P.getX(t + 1) - P.getX(t), P.getY(t + 1) - P.getY(t), P.getZ(t + 1) - P.getZ(t));
    assert.ok(Math.abs(e1.dot(new THREE.Vector3(...n0))) < 1e-6);
  }
});

test('#14 fracture(BufferGeometry): Meshes with BufferGeometry, [outer,inner] materials, vertex count %3, >=1 group', () => {
  const out = fracture(new THREE.BoxGeometry(2, 2, 2), { amount: 8, seed: 3 });
  assert.ok(out.length > 3);
  for (const m of out) {
    assert.ok(m.isMesh && m.geometry.isBufferGeometry);
    assert.ok(Array.isArray(m.material) && m.material.length === 2);
    const n = m.geometry.attributes.position.count;
    assert.ok(n > 0 && n % 3 === 0);
    assert.ok(m.geometry.groups.length >= 1);
    assert.equal(typeof m.userData.rayfire.index, 'number');
  }
  const custom = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ color: 0xff0000 })];
  const withMats = fracture(new THREE.BoxGeometry(2, 2, 2), { amount: 4, seed: 3, materials: { outer: custom[0], inner: custom[1] } });
  assert.equal(withMats[0].material[0], custom[0]);
  assert.equal(withMats[0].material[1], custom[1]);
});

test('fracture: non-geometry input throws a clear message', () => {
  for (const bad of [null, undefined, 42, 'x', {}, new THREE.Object3D(), { geometry: {} }]) assert.throws(() => fracture(bad, {}), /fracture: input/);
});

test('#15 fracture(Object3D): every fragment matrix EXACTLY equals source.matrixWorld; frozen; userData.rayfire', () => {
  const parent = new THREE.Group(); parent.position.set(5, -2, 1); parent.rotation.set(0.3, 0.1, -0.2);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial());
  mesh.position.set(1, 2, 3); mesh.rotation.set(0.5, 1.1, -0.4); mesh.scale.set(1.5, 0.75, 2);
  parent.add(mesh); parent.updateMatrixWorld(true);
  const out = fracture(mesh, { amount: 10, seed: 5 });
  assert.ok(out.length > 3);
  for (const f of out) {
    assert.equal(f.matrixAutoUpdate, false);
    assert.deepEqual(f.matrix.elements, mesh.matrixWorld.elements);
    const r = f.userData.rayfire;
    assert.ok(Number.isInteger(r.index));
    for (const k of ['x', 'y', 'z']) { assert.ok(Number.isFinite(r.centroidLocal[k])); assert.ok(r.aabbLocal.min[k] <= r.centroidLocal[k] + 1e-9 && r.centroidLocal[k] <= r.aabbLocal.max[k] + 1e-9); }
  }
  assert.deepEqual(out.map(f => f.userData.rayfire.index), out.map((_, i) => i));
  assert.notDeepEqual(mesh.matrixWorld.elements, new THREE.Matrix4().elements, 'sanity: transform is non-identity');
});

test('#15b fracture(Object3D) refreshes a stale matrixWorld (position set, updateMatrixWorld never called)', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(7, 0, 0);
  const [f] = fracture(mesh, { amount: 2, seed: 1 });
  assert.equal(f.matrix.elements[12], 7);
});

test('#16 reconstructed world-space fragment volume matches the source world volume (rel < 1e-5)', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3));
  mesh.position.set(4, 5, 6); mesh.rotation.set(0.7, -0.3, 1.2); mesh.scale.set(2, 0.5, 1.5);
  mesh.updateMatrixWorld(true);
  const src = meshVolume(geometryToTriangles(mesh.geometry).map(t => t.map(p => { const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(mesh.matrixWorld); return { x: v.x, y: v.y, z: v.z }; })));
  const frags = fracture(mesh, { amount: 14, seed: 9 });
  let sum = 0;
  for (const f of frags) {
    const tris = geometryToTriangles(f.geometry).map(t => t.map(p => { const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(f.matrix); return { x: v.x, y: v.y, z: v.z }; }));
    sum += Math.abs(meshVolume(tris));
  }
  assert.ok(Math.abs(Math.abs(src) - 6 * 2 * 0.5 * 1.5) < 1e-6, 'sanity: world volume = box volume x |scale product|');
  assert.ok(Math.abs(sum - Math.abs(src)) / Math.abs(src) < 1e-5, `sum=${sum} src=${src}`);
});

test('fracture opts pass through to the core: same seed -> same fragment count; also accepts am/sd aliases', () => {
  const a = fracture(new THREE.BoxGeometry(1, 1, 1), { amount: 9, seed: 4 }), b = fracture(new THREE.BoxGeometry(1, 1, 1), { am: 9, sd: 4 });
  assert.equal(a.length, b.length);
  assert.equal(fractureCells(geometryToTriangles(new THREE.BoxGeometry(1, 1, 1)), { amount: 9, seed: 4 }).length, a.length);
});
