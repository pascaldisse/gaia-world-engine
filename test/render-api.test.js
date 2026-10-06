// render-api: data-only interface + three backend. Parity = the static-part path in view.js must build the SAME
// three objects the pre-render-api code built (position/rotation/scale/shadow/userData/geometry+material identity).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { composeMat4, assertRenderBackend, validateMeshArrays, isMat4, RENDER_API_METHODS } from '../client/kernel/render-api/interface.js';
import { createThreeBackend, createBackend } from '../client/kernel/render-api/three-backend.js';
import { makeGeometry, makePartMaterial } from '../client/kernel/geometry.js';

const PARTS = [
  { shape: 'box', size: [2, 1, 3], color: '#884422', position: [1.1, 2.2, -3.3], rotation: [0.3, 4, -1], scale: [1, 2, 3] },
  { shape: 'sphere', radius: 2, color: '#2288ff', metalness: 0.4, scale: 1.5, castShadow: false, visible: false, renderOrder: 7 },
  { shape: 'cylinder', radiusTop: 1, radiusBottom: 2, height: 3, preset: 'stone', solid: true, position: [0, 5, 0], rotation: [0, 1.2, 0] },
];

function oldPath(part) { // verbatim pre-render-api logic
  const mesh = new THREE.Mesh(makeGeometry(part), makePartMaterial(part));
  mesh.userData.solid = part.solid !== undefined ? !!part.solid : !part.preset;
  if (part.visible === false) mesh.visible = false;
  mesh.position.set(...(part.position ?? [0, 0, 0]));
  mesh.rotation.set(...(part.rotation ?? [0, 0, 0]));
  if (part.scale) { if (Array.isArray(part.scale)) mesh.scale.set(...part.scale); else mesh.scale.setScalar(part.scale); }
  mesh.castShadow = part.castShadow ?? true;
  mesh.receiveShadow = true;
  if (part.renderOrder !== undefined) mesh.renderOrder = part.renderOrder;
  mesh.userData.kind = 'mesh-part';
  return mesh;
}

test('backend satisfies the interface', () => {
  const b = assertRenderBackend(createThreeBackend({ scene: new THREE.Scene() }));
  assert.equal(b.name, 'three');
  assert.ok(RENDER_API_METHODS.every((m) => typeof b[m] === 'function'));
  assert.throws(() => createBackend('nope', { scene: new THREE.Scene() }), /unknown render backend/);
});

test('composeMat4 == THREE.Matrix4.compose (same formula)', () => {
  const p = [1.1, 2.2, -3.3], r = [0.3, 4, -1], s = [1, 2, 3];
  const ours = composeMat4({ position: p, rotation: r, scale: s });
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));
  assert.ok(isMat4(ours));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(ours[i] - m.elements[i]) < 1e-14, `elem ${i}`);
});

test('static part via backend == old three path', () => {
  const scene = new THREE.Scene();
  const b = createThreeBackend({ scene });
  const group = new THREE.Group();
  scene.add(group);
  const gid = b.adoptNode(group);
  assert.equal(b.adoptNode(group), gid, 'adopt is idempotent');
  for (const part of PARTS) {
    const want = oldPath(part);
    const id = b.createInstance(b.createMeshFromRecipe(part), b.createMaterial(part), composeMat4({ position: part.position, rotation: part.rotation, scale: part.scale || 1 }), {
      parent: gid, euler: part.rotation ?? [0, 0, 0], visible: part.visible !== false, castShadow: part.castShadow ?? true, receiveShadow: true, renderOrder: part.renderOrder,
      tags: { solid: part.solid !== undefined ? !!part.solid : !part.preset, kind: 'mesh-part' },
    });
    const got = b.nativeNode(id);
    assert.equal(got.parent, group);
    assert.equal(got.geometry, want.geometry, 'shared cached geometry');
    assert.equal(got.material, want.material, 'shared cached material');
    for (const k of ['visible', 'castShadow', 'receiveShadow', 'renderOrder']) assert.equal(got[k], want[k], k);
    assert.deepEqual({ ...got.userData, renderNodeId: undefined }, { ...want.userData, renderNodeId: undefined });
    for (const [a, c] of [[got.position, want.position], [got.scale, want.scale]]) for (const ax of 'xyz') assert.ok(Math.abs(a[ax] - c[ax]) < 1e-12);
    assert.deepEqual([got.rotation.x, got.rotation.y, got.rotation.z], [want.rotation.x, want.rotation.y, want.rotation.z], 'euler preserved exactly');
    got.updateMatrix(); want.updateMatrix();
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(got.matrix.elements[i] - want.matrix.elements[i]) < 1e-12);
  }
  // recipe handles are deduped (cache-owned)
  assert.equal(b.createMeshFromRecipe(PARTS[0]), b.createMeshFromRecipe({ ...PARTS[0] }));
  assert.equal(b.createMaterial(PARTS[0]), b.createMaterial({ ...PARTS[0] }));
});

test('createMesh from typed arrays; removeNode frees + detaches; adopted removal keeps owner object', () => {
  const scene = new THREE.Scene();
  const b = createThreeBackend({ scene });
  const mesh = b.createMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint16Array([0, 1, 2]) });
  const mat = b.createMaterial({ color: '#ff0000' }, { map: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]), srgb: true } });
  const node = b.createInstance(mesh, mat, composeMat4({ position: [1, 2, 3] }));
  const obj = b.nativeNode(node);
  assert.equal(obj.parent, scene);
  assert.ok(obj.material.map?.isDataTexture);
  b.updateNode(node, { mat4: composeMat4({ position: [4, 5, 6] }), visible: false });
  assert.deepEqual(obj.position.toArray(), [4, 5, 6]);
  assert.equal(obj.visible, false);
  b.removeNode(node);
  assert.equal(obj.parent, null);
  assert.throws(() => b.nativeNode(node), /unknown node/);
  const g = new THREE.Group(); scene.add(g);
  const gid = b.adoptNode(g); b.removeNode(gid);
  assert.equal(g.parent, scene, 'adopted object stays with its owner');
  assert.throws(() => validateMeshArrays({ positions: new Float32Array(9), indices: new Uint16Array([0, 1, 9]) }), /index 9/);
  assert.throws(() => validateMeshArrays({ positions: new Float32Array(4) }), /multiple of 3/);
});

test('sun / point lights / setCamera', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1.5, 0.1, 100);
  const b = createThreeBackend({ scene, camera });
  const sun = b.setSun({ direction: [0, 1, 0], color: [1, 1, 1], intensity: 2, castShadow: true });
  const pl = b.addPointLight({ position: [1, 2, 3], color: [1, 0, 0], intensity: 5, distance: 10 });
  b.updatePointLight(pl, { intensity: 9 });
  assert.equal(scene.children.filter((c) => c.isLight).length, 2);
  b.removeLight(pl); b.removeLight(sun);
  assert.equal(scene.children.length, 0);
  const view = new THREE.Matrix4().makeTranslation(0, 0, -5);
  b.setCamera(view.elements, camera.projectionMatrix.elements);
  assert.ok(Math.abs(camera.position.z - 5) < 1e-9);
});
