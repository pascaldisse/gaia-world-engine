// r8: three material state → core FLAGS (blend / unlit / depthWrite / renderOrder / toneMapped). Eden sky = MeshBasic transparent, depthWrite:false, DoubleSide, additive|normal, renderOrder -1000+k.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { materialToParams, materialSig } from '../client/kernel/render-api/material-map.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

async function fakeWgpu() {
  const calls = []; let id = 0;
  const rec = (n) => (...a) => { calls.push([n, ...a]); return ++id; };
  const gpu = new Proxy({ hasTimestamps: () => false, createMaterial: rec('createMaterial'), updateMaterial: rec('updateMaterial'), destroyMaterial: rec('destroyMaterial'), createMesh: rec('createMesh'),
    createInstance: rec('createInstance'), updateInstance: rec('updateInstance'), removeInstance: rec('removeInstance'), setMaterialFlags: rec('setMaterialFlags'), setMaterialUnlitToneMapped: rec('setMaterialUnlitToneMapped'), setMaterialShadowCullBack: rec('setMaterialShadowCullBack'), setMaterialNoReceiveShadow: rec('setMaterialNoReceiveShadow') },
    { get: (t, k) => (k === 'then' ? undefined : t[k] ?? (() => 0)) });
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpu } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { calls, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}
const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); return g; };

test('material-map: plain MeshBasic → unlit; MeshBasicNodeMaterial with a *Node slot stays lit (TSL path owns its look)', () => {
  assert.equal(materialToParams(new THREE.MeshBasicMaterial()).params.unlit, true);
  assert.equal(materialToParams(new THREE.MeshStandardMaterial()).params.unlit, undefined);
  const plain = materialToParams(new THREE.MeshBasicNodeMaterial()).params;
  assert.equal(plain.unlit, true, 'node material without custom nodes == its non-node twin');
  assert.notEqual(materialSig(new THREE.MeshBasicMaterial({ toneMapped: false })), materialSig(new THREE.MeshBasicMaterial({ toneMapped: true })), 'toneMapped is in the change signature');
});

test('wgpu-backend: sky-style material → setMaterialFlags(blend alpha|additive, unlit, depthWrite 0, renderOrder) via adapter', async () => {
  const { calls, backend } = await fakeWgpu();
  const scene = new THREE.Scene(); const g = tri();
  const mk = (blending, ro) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: true, fog: false, side: THREE.DoubleSide, blending, opacity: 0.5, toneMapped: false })); m.renderOrder = ro; m.frustumCulled = false; return m; };
  const grp = new THREE.Group(); grp.renderOrder = -1000; grp.add(mk(THREE.NormalBlending, -1000), mk(THREE.AdditiveBlending, -999)); scene.add(grp);
  const ad = createSceneAdapter(backend, { three: THREE }); ad.sync(scene);
  const flags = calls.filter((c) => c[0] === 'setMaterialFlags');
  assert.equal(flags.length >= 2, true, JSON.stringify(flags));
  // (id, blend, unlit, depthWrite, renderOrder, castShadow)
  const alpha = flags.find((c) => c[2] === 1), add = flags.find((c) => c[2] === 2);
  assert.ok(alpha && add, 'alpha + additive blend flags');
  for (const f of [alpha, add]) { assert.equal(f[3], true, 'unlit'); assert.equal(f[4], 0, 'depthWrite off'); }
  const lastOrder = (id) => flags.filter((c) => c[1] === id).at(-1)[5];
  assert.equal(lastOrder(alpha[1]), -1000); assert.equal(lastOrder(add[1]), -999);
  assert.equal(calls.filter((c) => c[0] === 'setMaterialUnlitToneMapped').length >= 2, true);
});

test('wgpu-backend: opaque lit receiveShadow material pushes NO flags (default path untouched)', async () => {
  const { calls, backend } = await fakeWgpu();
  const scene = new THREE.Scene(); const o = new THREE.Mesh(tri(), new THREE.MeshStandardMaterial()); o.receiveShadow = true; scene.add(o);
  createSceneAdapter(backend, { three: THREE }).sync(scene);
  assert.equal(calls.filter((c) => c[0] === 'setMaterialFlags').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'setMaterialNoReceiveShadow').length, 0);
});

test('wgpu-backend: receiveShadow:false on EVERY user of a material → setMaterialNoReceiveShadow(id,true); one receiving user keeps it receiving', async () => {
  for (const mixed of [false, true]) {
    const { calls, backend } = await fakeWgpu();
    const scene = new THREE.Scene(); const g = tri(), mat = new THREE.MeshStandardMaterial();
    const a = new THREE.Mesh(g, mat), b = new THREE.Mesh(g, mat); b.receiveShadow = mixed; scene.add(a, b);
    const ad = createSceneAdapter(backend, { three: THREE }); ad.sync(scene);
    const last = calls.filter((c) => c[0] === 'setMaterialNoReceiveShadow' || c[0] === 'setMaterialFlags').at(-1);
    if (mixed) assert.notEqual(last?.[0], 'setMaterialNoReceiveShadow', 'a receiving user wins (old behaviour)');
    else assert.deepEqual([last[0], last[2]], ['setMaterialNoReceiveShadow', true]);
    if (!mixed) { b.receiveShadow = true; ad.sync(scene); assert.notEqual(calls.at(-1)[0], 'setMaterialNoReceiveShadow'); } // flip one user back → flags re-pushed without the opt-out
  }
});

test('wgpu-backend r9: FrontSide material → setMaterialShadowCullBack(id,true) AFTER setMaterialFlags (three shadowSide??side); DoubleSide / BackSide keep the double-sided caster', async () => {
  for (const [side, want] of [[THREE.FrontSide, true], [THREE.DoubleSide, false], [THREE.BackSide, false]]) {
    const { calls, backend } = await fakeWgpu();
    const scene = new THREE.Scene(); const o = new THREE.Mesh(tri(), new THREE.MeshStandardMaterial({ side })); o.receiveShadow = false; scene.add(o); // receiveShadow:false => setMaterialFlags path also fires (reset ordering)
    createSceneAdapter(backend, { three: THREE }).sync(scene);
    const cull = calls.filter((c) => c[0] === 'setMaterialShadowCullBack');
    assert.equal(cull.length > 0, want, `side=${side}`);
    if (want) {
      assert.equal(cull.at(-1)[2], true);
      const lastFlags = calls.map((c) => c[0]).lastIndexOf('setMaterialFlags');
      assert.ok(calls.map((c) => c[0]).lastIndexOf('setMaterialShadowCullBack') > lastFlags, 'cull flag pushed after the setMaterialFlags reset');
    }
  }
});
