// Humanoid kit stage 7 — texture sharing across LOD levels / pieces / bases: N glTF parses of ONE picture ⇒ ONE Texture,
// refcounted (template + live instance refs), disposed exactly once. Real GLTFLoader.parseAsync on real GLBs;
// only the image decoder is stubbed (node has no createImageBitmap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
globalThis.self ??= globalThis; // GLTFLoader.loadImageSource reads self.URL
globalThis.createImageBitmap = async (blob) => ({ width: 2, height: 2, close() {}, bytes: blob.size, tag: await blob.text() });
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { buildBaseGlb, buildPieces, buildPieceGlb } = await import('../tools/humanoid-placeholder.mjs');
const { mountHumanoid, evictHumanoidTemplates, humanoidTextureStats, _humanoidCache } = await import('../client/kernel/humanoid.js');
const { imageIdentity, internTextures, samplerSig, hashBytes, releaseTextures, retainTextures } = await import('../client/kernel/humanoid-tex.js');

// ---- GLB retexturing: add images/textures/material refs to a generated GLB ---------------------------------
function splitGlb(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, jl).toString());
  const bl = dv.getUint32(20 + jl, true);
  return { json, bin: Buffer.from(glb.buffer, glb.byteOffset + 28 + jl, bl) };
}
function joinGlb(json, bin) {
  const js0 = Buffer.from(JSON.stringify(json));
  const js = Buffer.concat([js0, Buffer.alloc((4 - (js0.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const out = Buffer.alloc(12 + 8 + js.length + 8 + b.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  out.writeUInt32LE(b.length, 20 + js.length); out.writeUInt32LE(0x004e4942, 24 + js.length); b.copy(out, 28 + js.length);
  return out;
}
// images: [{ name, embed: bool, sampler?: {} }] — tex 0 = baseColor, 1 = normal, 2 = team mask (extras.ee.teamMask)
// embed=true ⇒ bufferView bytes `IMG:<name>` (identity = content hash) · false ⇒ uri `tex/<name>.png` (identity = resolved url)
function texturize(glb, { images, uriBase = 'tex/', sampler = { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 } }) {
  const { json, bin } = splitGlb(glb);
  let blob = bin;
  json.images = []; json.textures = []; json.samplers = [sampler];
  images.forEach((im, i) => {
    if (im.embed) {
      const bytes = Buffer.from(`IMG:${im.name}`);
      json.bufferViews.push({ buffer: 0, byteOffset: blob.length, byteLength: bytes.length });
      json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: 'image/png', name: im.name });
      blob = Buffer.concat([blob, bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
    } else json.images.push({ uri: `${uriBase}${im.name}.png`, name: im.name });
    json.textures.push({ sampler: 0, source: i });
  });
  json.buffers[0].byteLength = blob.length;
  const m = json.materials.find((x) => x.name === 'skin') ?? json.materials[0];
  m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  if (images.length > 1) m.normalTexture = { index: 1 };
  if (images.length > 2) m.extras = { ...m.extras, ee: { teamMask: { index: 2, channel: 'R' } } };
  return joinGlb(json, blob);
}
const PREFIX = '/assets/humanoid';
const U = (rel) => `${PREFIX}/${rel}`;
const IMAGES = [{ name: 'color', embed: true }, { name: 'normal', embed: true }, { name: 'team', embed: true }];
const baseBytes = buildBaseGlb();
const pieces = buildPieces();
const helmet = pieces.find((p) => p.file.endsWith('helmet'));

function makeLoader(files) {
  const real = new GLTFLoader();
  const calls = [];
  return {
    calls,
    async loadAsync(url) {
      calls.push(url);
      const buf = files.get(url);
      if (!buf) throw new Error(`404 ${url}`);
      return real.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), url.slice(0, url.lastIndexOf('/') + 1));
    },
  };
}
// image bytes behind external uris: the stubbed fetch the ImageBitmapLoader uses
const realFetch = globalThis.fetch;
const fetched = [];
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === 'string' && url.startsWith(`${PREFIX}/`)) { fetched.push(url); return new Response(`IMG@${url}`); }
  return realFetch(url, ...rest);
};
const deps = (loader) => ({ loader, resolveUrl: (u) => u, fetchJson: async () => ({}) });
const mount = async (spec, loader) => {
  const parent = new THREE.Group(), g = new THREE.Group(); parent.add(g); g.userData.humanoidToken = 1;
  const root = await mountHumanoid(g, spec, 1, () => {}, deps(loader));
  g.updateMatrixWorld(true);
  return { g, root, h: root?.userData.humanoid };
};
const texturesOf = (root) => {
  const out = new Set();
  root.traverse((o) => { for (const m of [].concat(o.material ?? [])) for (const v of Object.values(m)) if (v?.isTexture) out.add(v); });
  return out;
};
const spyDispose = (textures) => { const hits = new Map(); for (const t of textures) { hits.set(t, 0); t.addEventListener('dispose', () => hits.set(t, hits.get(t) + 1)); } return hits; };

// one base + 2 LOD siblings, every file parsed on its own (so every parse builds its OWN Textures)
const lodSet = (tag, images = IMAGES, over = {}) => new Map([
  [U(`${tag}.glb`), texturize(baseBytes, { images, ...over })],
  [U(`${tag}_lod1.glb`), texturize(baseBytes, { images, ...over })],
  [U(`${tag}_lod2.glb`), texturize(baseBytes, { images, ...over })],
]);

// every Texture a unit could put on the GPU: material textures of its meshes + the team masks of the templates it uses
const allTextures = async (loader, root, kinds) => {
  const out = texturesOf(root);
  for (const [kind, url] of kinds) { const t = await _humanoidCache.get(loader, kind, url); for (const m of t.masks.values()) out.add(m); }
  return out;
};
const baseTex = async (loader, url) => { const t = await _humanoidCache.get(loader, 'base', url); let m; t.scene.traverse((o) => { if (o.material?.map) m = o.material.map; }); return m; };

test('3 LOD levels + a costume piece (embedded images): ONE Texture per image across ALL of them — materials AND team masks', async () => {
  const files = lodSet('emb');
  files.set(U('helmet.glb'), texturize(buildPieceGlb(helmet), { images: IMAGES }));
  const loader = makeLoader(files);
  const { root, h } = await mount({ base: U('emb.glb'), costume: { head: U('helmet.glb') }, lod: { distances: [10, 30] } }, loader);
  assert.ok(root && h.lod.groups.length === 3, 'mounted with all three levels');
  assert.equal(loader.calls.length, 4, '4 files parsed ⇒ every picture decoded 4× by the loader');
  const lv = [U('emb.glb'), U('emb_lod1.glb'), U('emb_lod2.glb')];
  const maps = await Promise.all(lv.map((u) => baseTex(loader, u)));
  assert.ok(maps.every((m) => m?.isTexture));
  assert.equal(new Set(maps).size, 1, 'level 0/1/2 colour maps are the SAME Texture object');
  const kinds = [...lv.map((u) => ['base', u]), ['piece', U('helmet.glb')]];
  const all = await allTextures(loader, root, kinds);
  assert.equal(all.size, 3, `color + normal + team mask = 3 Textures for 12 parses-worth of pictures, got ${all.size}`);
  assert.ok([...all].every((t) => t.userData.shared === true), 'all shared ⇒ view.disposeOwn never frees them per instance');
  assert.equal(humanoidTextureStats().textures >= 3, true);
  h.release();
  await evictHumanoidTemplates(loader);
});

test('external uris: same resolved url ⇒ shared (even via ../ from another dir); different url or same url under another sampler ⇒ NOT shared', async () => {
  const files = new Map([
    [U('u.glb'), texturize(baseBytes, { images: IMAGES.map((i) => ({ ...i, embed: false })) })],
    [U('lod/u_lod1.glb'), texturize(baseBytes, { images: IMAGES.map((i) => ({ ...i, embed: false })), uriBase: '../tex/' })], // -> /assets/humanoid/tex/*.png, same as base
    [U('lod/u_lod2.glb'), texturize(baseBytes, { images: IMAGES.map((i) => ({ ...i, embed: false })), uriBase: 'other/' })], // different files
    [U('lod/u_lod3.glb'), texturize(baseBytes, { images: IMAGES.map((i) => ({ ...i, embed: false })), uriBase: '../tex/', sampler: { magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 } })], // same files, other sampler
  ]);
  const loader = makeLoader(files);
  const { root, h } = await mount({ base: U('u.glb'), lod: { bases: [U('lod/u_lod1.glb'), U('lod/u_lod2.glb'), U('lod/u_lod3.glb')], distances: [5, 10, 20] } }, loader);
  assert.ok(root && h.lod.groups.length === 4);
  const [b, l1, l2, l3] = await Promise.all([U('u.glb'), U('lod/u_lod1.glb'), U('lod/u_lod2.glb'), U('lod/u_lod3.glb')].map((u) => baseTex(loader, u)));
  assert.equal(b, l1, 'uri ../tex/color.png from lod/ resolves to the base url ⇒ one Texture');
  assert.notEqual(b, l2, 'different url ⇒ different picture');
  assert.notEqual(b, l3, 'same url, other wrap/filter ⇒ must keep its own sampling config');
  assert.equal(l3.wrapS, THREE.RepeatWrapping);
  assert.equal(b.wrapS, THREE.ClampToEdgeWrapping);
  h.release();
  await evictHumanoidTemplates(loader);
});

test('refcount: instances + templates hold refs; texture disposed EXACTLY ONCE when the last holder lets go (not per level)', async () => {
  const files = lodSet('rc');
  const loader = makeLoader(files);
  const lv = [U('rc.glb'), U('rc_lod1.glb'), U('rc_lod2.glb')];
  const spec = { base: U('rc.glb'), lod: { distances: [10, 30] } };
  const a = await mount(spec, loader);
  const b = await mount(spec, loader);
  const kinds = lv.map((u) => ['base', u]);
  const all = await allTextures(loader, a.root, kinds);
  assert.equal(all.size, 3);
  const hits = spyDispose(all);
  const before = humanoidTextureStats();
  a.h.release(); a.h.release();                       // idempotent
  assert.deepEqual([...hits.values()], [0, 0, 0], 'instance released, templates + 2nd instance still hold');
  await evictHumanoidTemplates(loader, lv);           // templates dropped, instance b still alive
  assert.deepEqual([...hits.values()], [0, 0, 0], 'live instance keeps its pictures after template eviction');
  assert.equal(await evictHumanoidTemplates(loader, lv), 0, 'second evict is a no-op');
  b.h.release();
  assert.deepEqual([...hits.values()], [1, 1, 1], 'last holder gone ⇒ each texture disposed exactly once');
  b.h.release();
  assert.deepEqual([...hits.values()], [1, 1, 1], 'double release never double-frees');
  assert.equal(humanoidTextureStats().textures, before.textures - 3, 'registry entries dropped');
  // reload after eviction builds a fresh canonical set, still one per image
  const c = await mount(spec, loader);
  assert.equal((await allTextures(loader, c.root, kinds)).size, 3);
  assert.ok([...(await allTextures(loader, c.root, kinds))].every((t) => !hits.has(t)), 'fresh textures, not the disposed ones');
  c.h.release();
  await evictHumanoidTemplates(loader);
});

test('concurrent mounts of two bases that share pictures: still ONE Texture per image (race-safe commit)', async () => {
  const files = new Map([[U('x.glb'), texturize(baseBytes, { images: IMAGES })], [U('y.glb'), texturize(baseBytes, { images: IMAGES })]]);
  const loader = makeLoader(files);
  const [x, y] = await Promise.all([mount({ base: U('x.glb') }, loader), mount({ base: U('y.glb') }, loader)]);
  const all = await allTextures(loader, x.root, [['base', U('x.glb')], ['base', U('y.glb')]]);
  assert.equal(all.size, 3);
  const ys = await allTextures(loader, y.root, [['base', U('y.glb')]]);
  for (const t of ys) assert.ok(all.has(t));
  x.h.release(); y.h.release();
  await evictHumanoidTemplates(loader);
});

test('identity core: pixel data hash, no-identity textures untouched, sampler signature, hash sensitivity', async () => {
  const px = (n) => new THREE.DataTexture(new Uint8Array([n, 2, 3, 255, 9, 9, 9, 9]), 2, 1);
  const a = px(1), b = px(1), c = px(7);
  assert.equal(await imageIdentity(a), await imageIdentity(b));
  assert.notEqual(await imageIdentity(a), await imageIdentity(c));
  assert.equal(await imageIdentity(new THREE.Texture()), null, 'no image data ⇒ unidentifiable');
  const mk = (t) => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: t })); g.add(m); return { g, m }; };
  const s1 = mk(a), s2 = mk(b), s3 = mk(c), s4 = mk(new THREE.Texture());
  const k1 = await internTextures(s1.g, null), k2 = await internTextures(s2.g, null), k3 = await internTextures(s3.g, null);
  assert.equal(s2.m.material.map, a, 'duplicate swapped for the canonical');
  assert.equal(s3.m.material.map, c, 'different pixels untouched');
  assert.deepEqual(k1, k2);
  assert.notDeepEqual(k1, k3);
  const raw = s4.m.material.map;
  assert.deepEqual(await internTextures(s4.g, null), [], 'unidentifiable ⇒ no key, no ref');
  assert.equal(s4.m.material.map, raw);
  const hits = spyDispose([a, c]);
  releaseTextures(k1); assert.equal(hits.get(a), 0, 'second holder remains');
  releaseTextures(k2); assert.equal(hits.get(a), 1);
  releaseTextures(k3); assert.equal(hits.get(c), 1);
  assert.deepEqual(retainTextures(k1), [], 'retain of a dropped key is a no-op, never resurrects');
  const flipped = a.clone(); flipped.colorSpace = THREE.SRGBColorSpace;
  assert.notEqual(samplerSig(a), samplerSig(flipped));
  assert.notEqual(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abd')));
  assert.notEqual(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abc\0')));
});
