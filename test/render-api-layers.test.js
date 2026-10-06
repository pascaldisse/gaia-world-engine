// r10: three draws only objects whose layers intersect camera.layers (Renderer.js object.layers.test(camera.layers)); the adapter must not mirror the rest into the backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';

function fakeBackend() {
  const calls = []; let id = 0; const rec = (n) => (...a) => { calls.push([n, ...a]); return ++id; };
  const backend = {}; for (const n of ['createMesh', 'createMaterial', 'createInstance', 'updateInstance', 'removeInstance', 'destroyMesh', 'destroyMaterial', 'removeNode', 'setCamera', 'addNode', 'updateNode', 'setSun', 'removeLight', 'addPointLight', 'setAmbient', 'setBackground']) backend[n] = rec(n);
  return { calls, backend };
}
const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); return g; };

test('adapter: mesh on a layer the camera does not see is never created; seen via camera.layers.enable; per-object (children not culled by parent layer)', () => {
  const { calls, backend } = fakeBackend();
  const ad = createSceneAdapter(backend, { three: THREE });
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
  const gated = new THREE.Mesh(tri(), new THREE.MeshBasicMaterial()); gated.layers.set(3);
  const child = new THREE.Mesh(tri(), new THREE.MeshBasicMaterial()); gated.add(child);
  const plain = new THREE.Mesh(tri(), new THREE.MeshBasicMaterial());
  scene.add(gated, plain);
  ad.sync(scene, cam);
  const vis = () => calls.filter((c) => c[0] === 'createInstance' || c[0] === 'updateInstance').length; const nodes = () => calls.filter((c) => c[0] === 'createInstance').map((c) => c[4].visible);
  assert.equal(nodes().filter(Boolean).length, 2, 'plain + child (layer 0) visible; gated (layer 3) created hidden');
  assert.equal(ad.stats.layerCulled, 1);
  const n0 = calls.length; cam.layers.enable(3); ad.sync(scene, cam);
  assert.ok(calls.slice(n0).some((c) => c.slice(1).some((x) => x && typeof x === 'object' && x.visible === true)), 'camera enabling layer 3 flips the gated node visible via an update');
  assert.equal(ad.stats.layerCulled, 0);
});
