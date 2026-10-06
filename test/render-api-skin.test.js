// scene-adapter SkinnedMesh mirror: createSkin + createSkinnedMesh + identity instance; per-frame updateSkin only on change.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';

function rig() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const b0 = new THREE.Bone(), b1 = new THREE.Bone(); b1.position.set(0, 1, 0); b0.add(b1);
  const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
  m.position.set(2, 0, 0); m.add(b0);
  const scene = new THREE.Scene(); scene.add(m); scene.updateMatrixWorld(true);
  m.bind(new THREE.Skeleton([b0, b1]));
  return { scene, m, b1 };
}
const mul = (a, b) => new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).elements;

test('SkinnedMesh → createSkin/createSkinnedMesh/updateSkin, change-tracked, bind pose = matrixWorld', () => {
  const { scene, m, b1 } = rig();
  const be = createMockBackend({ optional: ['updateMesh', 'updateMaterial', 'createShaderMaterial', 'createSkin', 'updateSkin', 'createSkinnedMesh', 'destroySkin', 'destroySkinnedMesh'] });
  const ad = createSceneAdapter(be, { updateMatrices: true });
  ad.sync(scene);
  const log = be.take(), names = log.map((c) => c[0]);
  for (const k of ['createSkin', 'createSkinnedMesh', 'createInstance', 'updateSkin']) assert.ok(names.includes(k), k);
  assert.ok(!ad.stats.unsupported.has('SkinnedMesh:static-bind-pose-only'));
  const [ibm, nb] = log.find((c) => c[0] === 'createSkin').slice(1), pal = log.find((c) => c[0] === 'updateSkin')[2];
  assert.equal(nb, 2);
  for (let j = 0; j < 2; j++) {
    const p = mul(Array.from(pal.slice(j * 16, j * 16 + 16)), Array.from(ibm.slice(j * 16, j * 16 + 16)));
    p.forEach((v, i) => assert.ok(Math.abs(v - m.matrixWorld.elements[i]) < 1e-5, `joint ${j} [${i}] ${v}`));
  }
  ad.sync(scene);
  assert.deepEqual(be.take().map((c) => c[0]), [], 'idle frame = 0 calls');
  b1.rotation.z = 0.5;
  ad.sync(scene);
  assert.deepEqual(be.take().map((c) => c[0]), ['updateSkin'], 'bone move = palette upload only');
  scene.remove(m);
  ad.sync(scene);
  const gone = be.take().map((c) => c[0]);
  for (const k of ['removeNode', 'destroySkinnedMesh', 'destroySkin']) assert.ok(gone.includes(k), k);
});
