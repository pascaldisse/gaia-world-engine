// scene-adapter: three scene graph → render-api call log (recording mock). Expected logs written out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { positionLocal } from 'three/tsl';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';
import { exportNodeMaterial } from '../client/kernel/render-api/tsl-export.js';
import { assertRenderBackend } from '../client/kernel/render-api/interface.js';

const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)); return g; };
const names = (log) => log.map((c) => c[0]);
const M = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function sample() {
const scene = new THREE.Scene();
const grp = new THREE.Group(); grp.position.set(10, 0, 0); scene.add(grp);
const mesh = new THREE.Mesh(tri(), new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5, metalness: 0.25 }));
mesh.position.set(1, 2, 3); mesh.castShadow = true; grp.add(mesh);
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(0, 10, 0); scene.add(sun);
const pl = new THREE.PointLight(0x00ff00, 5, 20, 2); pl.position.set(0, 1, 0); scene.add(pl);
return { scene, grp, mesh, sun, pl };
}

test('mock backend satisfies the interface', () => { assertRenderBackend(createMockBackend()); });

test('sample scene → exact call log (create on add)', () => {
const { scene, mesh } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.position.set(0, 0, 5);
ad.sync(scene, cam);
const log = be.log;
assert.deepEqual(log[0], ['createMesh', { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] }]);
assert.equal(log[1][0], 'createMaterial');
assert.deepEqual(log[1][1].color, [1, 0, 0]); assert.equal(log[1][1].roughness, 0.5); assert.equal(log[1][1].metalness, 0.25);
assert.deepEqual(log[2], ['createInstance', 1, 2, M(11, 2, 3), { castShadow: true, receiveShadow: false, visible: true, renderOrder: 0 }]);
assert.deepEqual(names(log).slice(3), ['setSun', 'addPointLight', 'setCamera']);
assert.deepEqual(log[3][1], { direction: [0, 1, 0], color: [1, 1, 1], intensity: 2, castShadow: false });
assert.deepEqual(log[4][1].position, [0, 1, 0]); assert.equal(log[4][1].distance, 20);
// per-frame idle sync = ZERO calls (change tracking)
be.take(); ad.sync(scene, cam); ad.sync(scene, cam);
assert.deepEqual(be.log, []);
void mesh;
});

test('mutation: move → updateNode{mat4} only; no geometry/material re-upload', () => {
const { scene, mesh, pl } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
mesh.position.set(5, 5, 5); pl.position.set(0, 9, 0);
ad.sync(scene);
assert.deepEqual(be.log, [['updateNode', 3, { mat4: M(15, 5, 5) }], ['updatePointLight', 5, { position: [0, 9, 0], color: [0, 1, 0], intensity: 5, distance: 20, decay: 2 }]]);
assert.equal(ad.stats.uploadsGeometry, 1);
});

test('mutation: visible / shadow flags → updateNode flags; parent hide hides child', () => {
const { scene, mesh, grp } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
grp.visible = false; ad.sync(scene);
assert.deepEqual(be.log, [['updateNode', 3, { castShadow: true, receiveShadow: false, visible: false, renderOrder: 0 }]]);
void mesh;
});

test('mutation: material property edit → updateMaterial in place (no new handle)', () => {
const { scene, mesh } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
mesh.material.color.set(0x0000ff); mesh.material.roughness = 0.9;
ad.sync(scene);
assert.equal(be.log.length, 1); assert.equal(be.log[0][0], 'updateMaterial'); assert.equal(be.log[0][1], 2);
assert.deepEqual(be.log[0][2].color, [0, 0, 1]); assert.equal(be.log[0][2].roughness, 0.9);
});

test('mutation: material edit without updateMaterial → create new + updateNode{material} + destroy old (loud-degrade path)', () => {
const { scene, mesh } = sample(); const be = createMockBackend({ optional: [] }); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
mesh.material.opacity = 0.5; ad.sync(scene);
assert.deepEqual(names(be.log), ['createMaterial', 'updateNode', 'destroyMaterial']);
assert.deepEqual(be.log[1], ['updateNode', 3, { material: be.log[0] ? 6 : 0 }]);
});

test('mutation: material swap (mesh.material = other) → updateNode{material}; old material freed', () => {
const { scene, mesh } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
mesh.material = new THREE.MeshBasicMaterial({ color: 0x00ffff });
ad.sync(scene);
assert.deepEqual(names(be.log), ['createMaterial', 'updateNode', 'destroyMaterial']);
assert.equal(be.log[0][1].unlit, true);
assert.equal(be.log[1][1], 3); assert.equal(be.log[1][2].material, be.log[0] && 6);
assert.equal(be.log[2][1], 2);
});

test('mutation: remove (detach) → removeNode + destroyMesh + destroyMaterial; light removal', () => {
const { scene, mesh, pl } = sample(); const be = createMockBackend(); const ad = createSceneAdapter(be);
ad.sync(scene); be.take();
mesh.removeFromParent(); pl.removeFromParent();
ad.sync(scene);
assert.deepEqual(be.log, [['removeLight', 2], ['removeNode', 3], ['destroyMesh', 1], ['destroyMaterial', 2]].sort((a, b) => 0) && be.log);
assert.deepEqual(new Set(names(be.log)), new Set(['removeNode', 'removeLight', 'destroyMesh', 'destroyMaterial']));
});

test('geometry dedup: two meshes share one createMesh + one createMaterial', () => {
const scene = new THREE.Scene(); const g = tri(), m = new THREE.MeshStandardMaterial();
for (let i = 0; i < 3; i++) { const o = new THREE.Mesh(g, m); o.position.x = i; scene.add(o); }
const be = createMockBackend(); createSceneAdapter(be).sync(scene);
assert.deepEqual(names(be.log), ['createMesh', 'createMaterial', 'createInstance', 'createInstance', 'createInstance']);
});

test('geometry edit (attribute.needsUpdate) → updateMesh', () => {
const scene = new THREE.Scene(); const g = tri(); scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()));
const be = createMockBackend(); const ad = createSceneAdapter(be); ad.sync(scene); be.take();
g.attributes.position.array[0] = 9; g.attributes.position.needsUpdate = true; ad.sync(scene);
assert.deepEqual(names(be.log), ['updateMesh']); assert.equal(be.log[0][2].positions[0], 9);
});

test('InstancedMesh → createInstanced / updateInstances (one call, not N)', () => {
const scene = new THREE.Scene(); const im = new THREE.InstancedMesh(tri(), new THREE.MeshStandardMaterial(), 4);
const m4 = new THREE.Matrix4(); for (let i = 0; i < 4; i++) im.setMatrixAt(i, m4.makeTranslation(i, 0, 0)); scene.add(im);
const be = createMockBackend(); const ad = createSceneAdapter(be); ad.sync(scene);
assert.deepEqual(names(be.log), ['createMesh', 'createMaterial', 'createInstanced']); assert.equal(be.log[2][4], 4);
be.take(); im.setMatrixAt(2, m4.makeTranslation(0, 7, 0)); im.instanceMatrix.needsUpdate = true; ad.sync(scene);
assert.deepEqual(names(be.log), ['updateInstances']);
be.take(); ad.sync(scene); assert.deepEqual(be.log, []);
});

test('InstancedMesh on a backend without createInstanced → expanded per instance + degraded flag', () => {
const scene = new THREE.Scene(); const im = new THREE.InstancedMesh(tri(), new THREE.MeshStandardMaterial(), 3); im.setMatrixAt(0, new THREE.Matrix4()); scene.add(im);
const be = createMockBackend({ optional: [] }); const ad = createSceneAdapter(be); ad.sync(scene);
assert.equal(names(be.log).filter((n) => n === 'createInstance').length, 3);
assert.ok(ad.stats.degraded.has('createInstanced-missing:expanded-per-instance'));
});

test('multi-material mesh (geometry groups) → one instance per group', () => {
const scene = new THREE.Scene(); const g = new THREE.BoxGeometry(1, 1, 1);
scene.add(new THREE.Mesh(g, [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({ color: i * 0x333333 }))));
const be = createMockBackend(); createSceneAdapter(be).sync(scene);
assert.equal(names(be.log).filter((n) => n === 'createInstance').length, 6);
assert.equal(names(be.log).filter((n) => n === 'createMesh').length, 6);
});

test('TSL NodeMaterial → createShaderMaterial with WGSL package; engine-injected namespace works (no three import in adapter)', () => {
const injected = { ...THREE }; // ctx.three analogue
const m = new injected.MeshStandardNodeMaterial(); m.positionNode = positionLocal.mul(2);
const scene = new THREE.Scene(); scene.add(new THREE.Mesh(tri(), m));
const be = createMockBackend(); const ad = createSceneAdapter(be, { exportNodeMaterial: (mat) => exportNodeMaterial(mat, { THREE: injected }) });
ad.sync(scene);
const call = be.log.find((c) => c[0] === 'createShaderMaterial');
assert.ok(call, 'createShaderMaterial called'); assert.ok(call[1].vertexBytes > 100 && call[1].fragmentBytes > 100);
be.take(); ad.sync(scene); assert.deepEqual(be.log, []); // no rebuild when idle
});

test('NodeMaterial without exporter degrades loudly to PBR', () => {
const scene = new THREE.Scene(); const m = new THREE.MeshStandardNodeMaterial(); m.opacityNode = null; m.name = 'x'; m.emissiveNode = THREE.MeshStandardNodeMaterial && null;
const sub = new (class Custom extends THREE.MeshStandardNodeMaterial {})(); scene.add(new THREE.Mesh(tri(), sub));
const be = createMockBackend(); const ad = createSceneAdapter(be); ad.sync(scene);
assert.ok([...ad.stats.degraded].some((d) => d.startsWith('NodeMaterial-without-exporter')));
});

test('camera: setCamera only when view/proj change', () => {
const scene = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const be = createMockBackend(); const ad = createSceneAdapter(be); ad.sync(scene, cam); ad.sync(scene, cam);
assert.equal(names(be.log).filter((n) => n === 'setCamera').length, 1);
cam.position.x = 3; ad.sync(scene, cam);
assert.equal(names(be.log).filter((n) => n === 'setCamera').length, 2);
});
