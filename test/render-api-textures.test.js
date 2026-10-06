// r5-adapter: texture/material caching. idle frame = 0 texture work; GPU textures shared+refcounted by descriptor key (uuid:version); one CPU read per (texture,version).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';
import { materialSig, materialToParams, textureReads } from '../client/kernel/render-api/material-map.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); return g; };
const dataTex = () => { const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(200), 4, 4); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };
// fake canvas image: counts getImageData reads (the old adapter did this per mesh per frame)
const fakeCanvas = (reads) => ({ width: 2, height: 2, getContext: () => ({ getImageData: () => { reads.n++; return { data: new Uint8ClampedArray(16).fill(9) }; } }) });

test('materialSig: stable across frames, moves on edit; descriptor key = uuid:version, data lazy + read once', () => {
  const reads = { n: 0 }; const t = new THREE.Texture(fakeCanvas(reads)); t.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({ map: t });
  const s0 = materialSig(m), a = materialToParams(m).textures.map, b = materialToParams(m).textures.map;
  assert.equal(materialSig(m), s0);
  assert.equal(a, b, 'same descriptor object while version unchanged');
  assert.equal(a.key, `${t.uuid}:${t.version}`);
  assert.equal(reads.n, 0, 'no read until .data is touched');
  a.data; a.data; assert.equal(reads.n, 1, 'one read, memoised');
  m.color.set(0x123456); assert.notEqual(materialSig(m), s0);
  t.needsUpdate = true; const c = materialToParams(m).textures.map; assert.notEqual(c.key, a.key); c.data; assert.equal(reads.n, 2, 're-read only after version bump');
});

test('adapter: N meshes sharing a canvas-textured material → idle frames do 0 texture reads and 0 material calls', () => {
  const reads = { n: 0 }; const t = new THREE.Texture(fakeCanvas(reads)); t.needsUpdate = true;
  const scene = new THREE.Scene(); const mat = new THREE.MeshStandardMaterial({ map: t }); const g = tri();
  for (let i = 0; i < 20; i++) { const m = new THREE.Mesh(g, mat); m.position.set(i, 0, 0); scene.add(m); }
  const be = createMockBackend(); const ad = createSceneAdapter(be);
  const origCreate = be.createMaterial; let mc = 0, tr = 0;
  be.createMaterial = (p, tx) => { mc++; if (tx?.map) tx.map.data; return origCreate(p, tx); };
  ad.sync(scene); assert.equal(mc, 1); assert.equal(reads.n, 1);
  const r0 = textureReads.count, n0 = be.log.length;
  for (let f = 0; f < 5; f++) ad.sync(scene);
  assert.equal(reads.n, 1); assert.equal(textureReads.count, r0); assert.equal(mc, 1); assert.equal(be.log.length, n0, 'idle frames: zero backend calls');
  t.needsUpdate = true; ad.sync(scene);
  assert.equal(be.log.slice(n0).filter((c) => /Material/.test(c[0])).length >= 1, true, 'texture version bump → material re-described');
});

async function fakeWgpu() {
  const c = { tex: 0, destroyTex: 0, mat: 0, updMat: 0, destroyMat: 0, calls: [] }; let id = 0;
  const gpu = { hasTimestamps: () => false, createTextureLinear: () => { c.calls.push(['linear']); return ++id; }, createTextureArray: (...a) => { c.calls.push(['array', a[2], a[4]]); return ++id; }, updateTextureLayer: (_i, l) => { c.calls.push(['layer', l]); }, setMaterialMaps: (...a) => { c.calls.push(['maps', ...a]); }, setMaterialFlags: (...a) => { c.calls.push(['flags', ...a]); }, setMeshUv1: () => {}, setMeshColors: () => {}, createTexture: () => { c.tex++; return ++id; }, destroyTexture: () => { c.destroyTex++; }, createMaterial: (...a) => { c.mat++; c.lastArgs = a; return ++id; }, updateMaterial: (...a) => { c.updMat++; c.lastArgs = a; }, destroyMaterial: () => { c.destroyMat++; } };
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpu } };
  // Fake navigator ONLY while constructing; restore so later files in the same bun process (GLTFLoader reads navigator.userAgent) see the real one.
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { c, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}

test('wgpu-backend: one GPU texture per key (refcounted), updateMaterial in place, release on destroy', async () => {
  const { c, backend } = await fakeWgpu();
  const px = new Uint8Array(16); let dataReads = 0;
  const desc = (key) => ({ width: 2, height: 2, key, get data() { dataReads++; return px; } });
  const m1 = backend.createMaterial({}, { map: desc('u:1') }), m2 = backend.createMaterial({}, { map: desc('u:1') });
  assert.equal(c.tex, 1, 'shared'); assert.equal(dataReads, 1, 'data read only on the miss');
  backend.updateMaterial(m2, {}, { map: desc('u:2') });
  assert.equal(c.tex, 2); assert.equal(c.updMat, 1); assert.equal(c.destroyTex, 0, 'u:1 still held by m1');
  backend.destroyMaterial(m1); assert.equal(c.destroyTex, 1, 'u:1 released at refcount 0');
  backend.destroyMaterial(m2); assert.equal(c.destroyTex, 2);
  assert.equal(backend.textureStats().live, 0);
});

test('wgpu-backend r6: array texture (layer updates only on version bump), linear flag, side + blend + maps reach the core', async () => {
  const { c, backend } = await fakeWgpu();
  const px = new Uint8Array(2 * 2 * 4 * 3); let dirty = [1];
  const arr = (version) => ({ array: true, width: 2, height: 2, layers: 3, srgb: true, key: 'a:array', version, data: px, takeLayerUpdates: () => { const d = dirty; dirty = null; return d; } });
  const lin = { width: 2, height: 2, srgb: false, key: 'n:1', data: new Uint8Array(16) };
  const m = backend.createMaterial({ transparent: true, opacity: 0.5, backSide: true }, { array: arr(1), normalMap: lin });
  assert.deepEqual(c.calls.find((x) => x[0] === 'array'), ['array', 3, true]);
  assert.equal(c.calls.filter((x) => x[0] === 'linear').length, 1, 'normal map uploaded linear (colour space flag honored)');
  const maps = c.calls.find((x) => x[0] === 'maps'); assert.equal(maps[9], 2, 'BackSide → side 2'); assert.ok(maps[2] > 0 && maps[3] > 0, 'array + normal ids');
  assert.equal(c.calls.find((x) => x[0] === 'flags')[2], 1, 'transparent → alpha blend');
  dirty = [2]; backend.updateMaterial(m, { transparent: true, opacity: 0.5, backSide: true }, { array: arr(2), normalMap: lin });
  assert.deepEqual(c.calls.filter((x) => x[0] === 'layer'), [['layer', 2]], 'only the dirty layer re-uploaded, no new array');
  assert.equal(c.calls.filter((x) => x[0] === 'array').length, 1);
  assert.throws(() => backend.createMaterial({}, { map: { refused: 'compressed-texture (test)' } }), /refused/);
});

// r7: three emissiveMap === map -> emissive x base texel (4th emissive float = flag); distinct emissiveMap -> own slot (r6 setMaterialMaps), NOT degraded
test('r7+r6 emissiveMap===map -> emissive[3]=1 and emissive slot unbound; distinct -> bound in the emissive slot, no degraded', async () => {
  const { c, backend } = await fakeWgpu();
  const emissive = new THREE.Color(0.4, 0.2, 0.1);
  const t = dataTex(), other = dataTex();
  const same = new THREE.MeshStandardMaterial({ map: t, emissive, emissiveMap: t });
  const pSame = materialToParams(same);
  assert.equal(pSame.textures.emissiveMap.key, pSame.textures.map.key, 'same Texture object -> same descriptor key');
  assert.equal(pSame.degraded, undefined);
  backend.createMaterial(pSame.params, pSame.textures);
  assert.equal(c.tex, 1, 'one GPU texture for map + emissiveMap');
  assert.equal(c.lastArgs[5].length, 4); assert.equal(c.lastArgs[5][3], 1);
  assert.ok(Math.abs(c.lastArgs[5][0] - 0.4) < 1e-5);
  // no emissiveMap -> 3 floats, flat
  const plain = materialToParams(new THREE.MeshStandardMaterial({ map: t, emissive }));
  backend.createMaterial(plain.params, plain.textures); assert.equal(c.lastArgs[5].length, 3);
  assert.equal(c.calls.filter((x) => x[0] === 'maps').at(-1)[6], 0, 'same-key emissiveMap: emissive slot unbound (no double multiply)');
  // distinct emissiveMap: bound in its own slot, flat 3-float emissive, not degraded
  const dm = new THREE.MeshStandardMaterial({ map: t, emissive, emissiveMap: other });
  const pd = materialToParams(dm); assert.equal(pd.degraded, undefined);
  backend.createMaterial(pd.params, pd.textures); assert.equal(c.lastArgs[5].length, 3);
  assert.ok(c.calls.filter((x) => x[0] === 'maps').at(-1)[6] > 0, 'distinct emissiveMap bound');
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(tri(), dm));
  const ad = createSceneAdapter(createMockBackend()); ad.sync(scene);
  assert.ok(!ad.stats.degraded.has('emissiveMap-distinct'));
  const sc2 = new THREE.Scene(); sc2.add(new THREE.Mesh(tri(), same));
  const ad2 = createSceneAdapter(createMockBackend()); ad2.sync(sc2);
  assert.ok(!ad2.stats.degraded.has('emissiveMap-distinct'));
});
