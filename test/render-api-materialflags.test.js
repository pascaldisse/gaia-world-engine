// r8: three material state → core FLAGS (blend / unlit / depthWrite / renderOrder / toneMapped). Eden sky = MeshBasic transparent, depthWrite:false, DoubleSide, additive|normal, renderOrder -1000+k.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { materialToParams, materialSig } from '../client/kernel/render-api/material-map.js';
import { isGIEligibleMaterial } from '../client/kernel/gi/gi-attach.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

async function fakeWgpu() {
  const calls = []; let id = 0;
  const rec = (n) => (...a) => { calls.push([n, ...a]); return ++id; };
  const gpu = new Proxy({ hasTimestamps: () => false, createMaterial: rec('createMaterial'), updateMaterial: rec('updateMaterial'), destroyMaterial: rec('destroyMaterial'), createMesh: rec('createMesh'),
    createInstance: rec('createInstance'), updateInstance: rec('updateInstance'), removeInstance: rec('removeInstance'), setMaterialFlags: rec('setMaterialFlags'), setMaterialUnlitToneMapped: rec('setMaterialUnlitToneMapped'), setMaterialNoColorWrite: rec('setMaterialNoColorWrite'), setMaterialNoDepthTest: rec('setMaterialNoDepthTest'), setMaterialNoGi: rec('setMaterialNoGi'), setMaterialShadowCullBack: rec('setMaterialShadowCullBack'), setMaterialNoReceiveShadow: rec('setMaterialNoReceiveShadow') },
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

test('r9: noGi mirrors three gi-attach eligibility exactly (plain material = hemi only; Standard/Physical/Lambert NodeMaterial = GI receiver)', () => {
  for (const M of ['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshBasicMaterial', 'MeshStandardNodeMaterial', 'MeshPhysicalNodeMaterial', 'MeshLambertNodeMaterial', 'MeshBasicNodeMaterial']) {
    const m = new THREE[M]();
    assert.equal(!!materialToParams(m).params.noGi, !isGIEligibleMaterial(m), M);
  }
});

function skinnedRig(mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const b0 = new THREE.Bone(), m = new THREE.SkinnedMesh(g, mat); m.add(b0);
  const scene = new THREE.Scene(); scene.add(m); scene.updateMatrixWorld(true); m.bind(new THREE.Skeleton([b0]));
  return scene;
}

test('r9: SkinnedMesh + static mesh with a plain MeshStandardMaterial (Eden figure) → setMaterialNoGi(id,true); NodeMaterial figure → none; stays set after a flags push', async () => {
  for (const [Mat, expectNoGi] of [[THREE.MeshStandardMaterial, true], [THREE.MeshStandardNodeMaterial, false]]) {
    for (const skinned of [true, false]) {
      const { calls, backend } = await fakeWgpu();
      const mat = new Mat({ roughness: 0.9, metalness: 0 });
      const scene = skinned ? skinnedRig(mat) : (() => { const s = new THREE.Scene(); s.add(new THREE.Mesh(tri(), mat)); return s; })();
      const ad = createSceneAdapter(backend, { three: THREE }); ad.sync(scene);
      const gi = calls.filter((c) => c[0] === 'setMaterialNoGi');
      assert.equal(gi.length > 0, expectNoGi, `${Mat.name} skinned=${skinned}`);
      if (expectNoGi) {
        const last = calls.filter((c) => c[0] === 'setMaterialNoGi' || c[0] === 'setMaterialFlags').at(-1);
        assert.deepEqual([last[0], last[2]], ['setMaterialNoGi', true]);
        mat.transparent = true; mat.opacity = 0.5; mat.needsUpdate = true; ad.sync(scene); // blend flag push resets the core opt-out → must be re-applied after it
        const after = calls.filter((c) => c[0] === 'setMaterialNoGi' || c[0] === 'setMaterialFlags').at(-1);
        assert.equal(after[0], 'setMaterialNoGi');
      }
    }
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

test('r11 colorWrite:false (depth-only occluder) → setMaterialNoColorWrite(id,true) AFTER setMaterialFlags, depthWrite forwarded; default colorWrite pushes nothing', async () => {
  assert.equal(materialToParams(new THREE.MeshBasicMaterial({ colorWrite: false })).params.colorWrite, false);
  assert.equal(materialToParams(new THREE.MeshBasicMaterial()).params.colorWrite, true);
  assert.notEqual(materialSig(new THREE.MeshBasicMaterial({ colorWrite: false })), materialSig(new THREE.MeshBasicMaterial()), 'colorWrite is in the change signature');
  const { calls, backend } = await fakeWgpu();
  const scene = new THREE.Scene(); const g = tri();
  const occ = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true })); occ.frustumCulled = false;
  const dbg = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ colorWrite: false, depthWrite: false })); dbg.frustumCulled = false;
  scene.add(occ, dbg);
  createSceneAdapter(backend, { three: THREE }).sync(scene);
  const no = calls.filter((c) => c[0] === 'setMaterialNoColorWrite');
  assert.equal(new Set(no.map((c) => c[1])).size, 2, JSON.stringify(no)); // pushFlags re-pushes (idempotent) like every other flag for (const c of no) assert.equal(c[2], true);
  for (const c of no) { const fi = calls.findIndex((x) => x[0] === 'setMaterialFlags' && x[1] === c[1]), ni = calls.indexOf(c); assert.ok(fi >= 0 && fi < ni, 'flags pushed before (flags reset it)'); }
  const dw = (id) => calls.filter((c) => c[0] === 'setMaterialFlags' && c[1] === id).at(-1)[4];
  assert.deepEqual([...new Set(no.map((c) => dw(c[1])))].sort(), [-1, 0], 'depthWrite forwarded alongside (default -1 / false 0)');
  const { calls: c2, backend: b2 } = await fakeWgpu(); const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()));
  createSceneAdapter(b2, { three: THREE }).sync(s2);
  assert.equal(c2.filter((c) => c[0] === 'setMaterialNoColorWrite').length, 0);
});

test('r11 depthTest:false (HUD/xray) → setMaterialNoDepthTest(id,true) AFTER setMaterialFlags; in change signature; default pushes nothing', async () => {
  assert.equal(materialToParams(new THREE.MeshBasicMaterial({ depthTest: false })).params.depthTest, false);
  assert.notEqual(materialSig(new THREE.MeshBasicMaterial({ depthTest: false })), materialSig(new THREE.MeshBasicMaterial()));
  const { calls, backend } = await fakeWgpu();
  const scene = new THREE.Scene(); const g = tri();
  const hud = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ depthTest: false })); hud.frustumCulled = false;
  const pbr = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ depthTest: false, depthWrite: false })); pbr.frustumCulled = false;
  scene.add(hud, pbr);
  createSceneAdapter(backend, { three: THREE }).sync(scene);
  const no = calls.filter((c) => c[0] === 'setMaterialNoDepthTest');
  assert.equal(new Set(no.map((c) => c[1])).size, 2, JSON.stringify(no));
  for (const c of no) { assert.equal(c[2], true); const fi = calls.findIndex((x) => x[0] === 'setMaterialFlags' && x[1] === c[1]); assert.ok(fi >= 0 && fi < calls.indexOf(c), 'flags pushed before (flags reset it)'); }
  const { calls: c2, backend: b2 } = await fakeWgpu(); const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()));
  createSceneAdapter(b2, { three: THREE }).sync(s2);
  assert.equal(c2.filter((c) => c[0] === 'setMaterialNoDepthTest').length, 0);
});
