import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StaticBatcher } from '../client/kernel/static-batch.js';
import { SunShadows } from '../client/kernel/lighting/shadows.js';

const box = (w = 1) => new THREE.BoxGeometry(w, w, w);
const rig = (opts = {}) => {
  const scene = new THREE.Scene(), mat = new THREE.MeshStandardMaterial(), mat2 = new THREE.MeshStandardMaterial();
  const mk = (x, m = mat, g = box()) => { const o = new THREE.Mesh(g, m); o.position.set(x, 0, 0); o.castShadow = true; scene.add(o); return o; };
  const b = new StaticBatcher(scene, { enabled: true, scanEvery: 1, settleScans: 1, ...opts });
  const run = (n = 4) => { scene.updateMatrixWorld(true); for (let i = 0; i < n; i++) b.update(); };
  return { scene, mat, mat2, mk, b, run };
};

test('default is OFF: nothing touched', () => {
  const scene = new THREE.Scene(); const o = new THREE.Mesh(box(), new THREE.MeshStandardMaterial()); scene.add(o, new THREE.Mesh(box(), o.material));
  const b = new StaticBatcher(scene); for (let i = 0; i < 50; i++) b.update();
  assert.equal(b.chunks.length, 0); assert.equal(scene.children.length, 2); assert.equal(o.layers.mask, 1);
});

test('same-material static meshes merge; originals hidden by layers, visible untouched; vertex count preserved; world-space positions', () => {
  const { scene, mk, b, run } = rig({ shadowProxy: false });
  const a = mk(0), c = mk(5), d = mk(100); run();
  const chunk = scene.children.find((o) => o.userData.staticBatch);
  assert.ok(chunk); assert.equal(b.stats.batchedMeshes, 2); // d is alone in its cell
  assert.equal(chunk.geometry.attributes.position.count, 48);
  assert.equal(a.layers.mask, 0); assert.equal(a.visible, true); assert.equal(d.layers.mask, 1);
  chunk.geometry.computeBoundingBox(); assert.ok(Math.abs(chunk.geometry.boundingBox.max.x - 5.5) < 1e-5 && Math.abs(chunk.geometry.boundingBox.min.x + 0.5) < 1e-5);
});

test('skinned / transparent / alpha / noBatch / dynamic excluded; different materials not merged', () => {
  const { scene, mat, mat2, mk, b, run } = rig({ shadowProxy: false });
  const t = new THREE.MeshStandardMaterial({ transparent: true });
  mk(0, t); mk(1, t); const n1 = mk(2); n1.userData.noBatch = true; const n2 = mk(3); n2.userData.dynamic = true; mk(4, mat2); mk(5, mat);
  run(); assert.equal(b.chunks.length, 0);
});

test('a moved member un-batches its chunk (originals restored, flagged noBatch) — no frozen stale geometry', () => {
  const { scene, mk, b, run } = rig({ shadowProxy: false });
  const a = mk(0), c = mk(2); run(); assert.equal(b.chunks.length, 1);
  a.position.x = 3; scene.updateMatrixWorld(true); b.update();
  assert.equal(b.chunks.length, 0); assert.equal(a.layers.mask, 1); assert.equal(c.layers.mask, 1); assert.equal(a.userData.noBatch, true);
  assert.equal(scene.children.filter((o) => o.userData.staticBatch).length, 0);
  run(); assert.equal(b.chunks.length, 0); // flagged: never re-batched
});

test('a hidden member un-batches', () => {
  const { scene, mk, b, run } = rig({ shadowProxy: false });
  const a = mk(0); mk(2); run(); assert.equal(b.chunks.length, 1); a.visible = false; b.update(); assert.equal(b.chunks.length, 0);
});

test('negative-determinant mesh keeps outward winding (index flipped)', () => {
  const { scene, mat, mk, b, run } = rig({ shadowProxy: false });
  const a = mk(0), c = mk(2); a.scale.x = -1; c.scale.x = -1; run();
  const g = scene.children.find((o) => o.userData.staticBatch).geometry, p = g.attributes.position, ix = g.index.array;
  // signed volume of the merged mesh must be positive (outward winding) per cube: 2 cubes of volume 1 each
  let vol = 0; for (let i = 0; i < ix.length; i += 3) { const A = new THREE.Vector3().fromBufferAttribute(p, ix[i]), B = new THREE.Vector3().fromBufferAttribute(p, ix[i + 1]), C = new THREE.Vector3().fromBufferAttribute(p, ix[i + 2]); vol += A.dot(B.cross(C)) / 6; }
  assert.ok(Math.abs(vol - 2) < 1e-4, `vol ${vol}`);
});

test('shadow proxy: static opaque casters merge ACROSS materials on the shadow layer; originals stop casting; alpha-tested stay casters; release restores', () => {
  const { scene, mat, mat2, mk, b, run } = rig();
  const alpha = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
  const a = mk(0, mat), c = mk(2, mat2), e = mk(4, alpha); mk(6, alpha);
  run();
  const proxy = scene.children.find((o) => o.userData.shadowProxy);
  assert.ok(proxy); assert.equal(proxy.layers.mask, 1 << 5); assert.equal(proxy.castShadow, true);
  assert.equal(a.castShadow, false); assert.equal(c.castShadow, false); assert.equal(e.castShadow, true);
  assert.equal(proxy.geometry.attributes.position.count, 48); assert.equal(Object.keys(proxy.geometry.attributes).join(), 'position');
  c.position.x = 9; scene.updateMatrixWorld(true); b.update();
  assert.equal(scene.children.some((o) => o.userData.shadowProxy), false); assert.equal(a.castShadow, true); assert.equal(c.castShadow, true);
});

test('shadow cameras of sun lights gain the proxy layer', () => {
  const { scene, mk, b, run } = rig();
  const sun = new THREE.DirectionalLight(); sun.castShadow = true; scene.add(sun); mk(0); mk(1); run();
  assert.ok(sun.shadow.camera.layers.isEnabled(5)); assert.ok(sun.shadow.camera.layers.isEnabled(0));
});

test('disable() restores everything', () => {
  const { scene, mk, b, run } = rig(); const a = mk(0); mk(1); run(); assert.ok(b.chunks.length);
  b.setOptions({ enabled: false }); b.update();
  assert.equal(b.chunks.length, 0); assert.equal(a.layers.mask, 1); assert.equal(a.castShadow, true); assert.equal(scene.children.filter((o) => o.userData.staticBatch || o.userData.shadowProxy).length, 0);
});

const srig = (n, cfg) => { const s = new SunShadows({ position: new THREE.Vector3(1, 2, 3) }); s.node = { lights: Array.from({ length: n }, () => ({ shadow: { autoUpdate: true, needsUpdate: false } })) }; s.config = { guard: false, ...cfg }; return s; };
test('staticCache: cascade 0 every frame; far cascades render once, then only on sun move / every cacheRefresh frames (offset per cascade)', () => {
  const s = srig(4, { staticCache: true, cacheRefresh: 10 }); const hits = [[], [], [], []];
  for (let f = 0; f < 25; f++) { s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick(); s.node.lights.forEach((l, i) => { if (i === 0 ? l.shadow.autoUpdate : l.shadow.needsUpdate) hits[i].push(f); }); }
  assert.equal(hits[0].length, 25); assert.deepEqual(hits[1], [0, 8, 18]); assert.deepEqual(hits[2], [0, 7, 17]); assert.deepEqual(hits[3], [0, 6, 16]);
  s.sun.position.set(5, 5, 5); s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick();
  assert.ok(s.node.lights.slice(1).every((l) => l.shadow.needsUpdate), 'sun move refreshes all far cascades');
});
test('staticCache off again restores autoUpdate', () => {
  const s = srig(3, { staticCache: true }); s.tick(); s.config.staticCache = false; s.config.stagger = false; s.tick();
  assert.ok(s.node.lights.every((l) => l.shadow.autoUpdate === true));
});
