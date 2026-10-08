// r13-bc: three CompressedTexture (BC/DXT) -> render-api -> wasm createTextureCompressed. Procedural BC1 blocks; refusals land in adapter.stats.unsupported (never silent).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';
import { materialToParams } from '../client/kernel/render-api/material-map.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); return g; };
// solid-colour BC1 block (c0 = RGB565 colour, all indices 0)
const bc1 = (c0) => Uint8Array.of(c0 & 255, c0 >> 8, 0, 0, 0, 0, 0, 0);
const RED = 0xF800;
function compressed(format, size, mips, extra = {}) {
  const mm = mips.map((data, l) => ({ data, width: Math.max(1, size >> l), height: Math.max(1, size >> l) }));
  const t = new THREE.CompressedTexture(mm, size, size, format); t.mipmaps = mm; t.needsUpdate = true; Object.assign(t, extra); return t;
}
async function fakeWgpu({ withCompressed = true, failWith = null } = {}) {
  const c = { comp: [], calls: [] }; let id = 0;
  const gpu = { hasTimestamps: () => false, setMaterialMaps: () => {}, setMaterialFlags: () => {}, createTexture: () => ++id, destroyTexture: (i) => c.calls.push(['destroy', i]), createMaterial: () => ++id, updateMaterial: () => {}, destroyMaterial: () => {},
    compressedStats: () => Uint32Array.of(1, 0, 0, 0, 0, 0) };
  if (withCompressed) gpu.createTextureCompressed = (...a) => { if (failWith) throw new Error(failWith); c.comp.push(a); return ++id; };
  // every other wasm method = no-op returning a fresh id; 'then' stays undefined (async-return safe), createTextureCompressed only when withCompressed
  const gpuP = new Proxy(gpu, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'createTextureCompressed' || typeof k === 'symbol') ? undefined : () => ++id) });
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpuP } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { c, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}

test('descriptor: DXT1-RGB CompressedTexture -> compressed descriptor with mip chain concatenated lazily (no longer silently dropped)', () => {
  const t = compressed(33776, 8, [new Uint8Array(32).fill(1), new Uint8Array(8).fill(2), new Uint8Array(8).fill(3), new Uint8Array(8).fill(4)], { colorSpace: THREE.SRGBColorSpace });
  const p = materialToParams(new THREE.MeshStandardMaterial({ map: t }));
  const d = p.textures.map;
  assert.equal(d.compressed, true); assert.equal(d.format, 33776); assert.equal(d.width, 8); assert.equal(d.mipCount, 4); assert.equal(d.srgb, true); assert.equal(d.flipY, false);
  assert.equal(d.key, `${t.uuid}:${t.version}`);
  assert.equal(d.data.length, 32 + 8 + 8 + 8); assert.equal(d.data[0], 1); assert.equal(d.data[32], 2); assert.equal(d.data[47], 4);
  assert.equal(p.unsupported, undefined);
});

test('backend: compressed map reaches gpu.createTextureCompressed(format,w,h,mips,bytes,srgb,flip); shared by key (one upload for two materials)', async () => {
  const { c, backend } = await fakeWgpu();
  const t = compressed(33779, 4, [new Uint8Array(16).fill(7)], { colorSpace: THREE.SRGBColorSpace });
  const a = materialToParams(new THREE.MeshStandardMaterial({ map: t })), b = materialToParams(new THREE.MeshStandardMaterial({ map: t }));
  backend.createMaterial(a.params, a.textures); backend.createMaterial(b.params, b.textures);
  assert.equal(c.comp.length, 1, 'second material hits the key cache');
  const [fmt, w, h, mips, bytes, srgb, flip] = c.comp[0];
  assert.deepEqual([fmt, w, h, mips, bytes.length, srgb, flip], [33779, 4, 4, 1, 16, true, false]);
  assert.deepEqual(backend.drainUnsupported(), []);
  assert.deepEqual(backend.textureStats().compressedCore, [1, 0, 0, 0, 0, 0]);
});

test('linear colour space + flipY are passed through', async () => {
  const { c, backend } = await fakeWgpu();
  const t = compressed(33777, 4, [new Uint8Array(8)], { colorSpace: THREE.NoColorSpace, flipY: true });
  const p = materialToParams(new THREE.MeshStandardMaterial({ normalMap: t }));
  backend.createMaterial(p.params, p.textures);
  assert.equal(c.comp[0][5], false); assert.equal(c.comp[0][6], true);
});

test('refusals are RECORDED in adapter.stats.unsupported: unknown format, no mipmaps, bad mip chain, old wasm pkg, core error', async () => {
  const scene = new THREE.Scene();
  const mk = (t) => { const m = new THREE.Mesh(tri(), new THREE.MeshStandardMaterial({ map: t })); scene.add(m); return m; };
  mk(compressed(37808, 4, [new Uint8Array(16)])); // ASTC 4x4
  mk(compressed(33776, 4, [])); // no mips
  const bad = compressed(33776, 8, [new Uint8Array(32), new Uint8Array(8)]); bad.mipmaps[1].width = 3; mk(bad);
  const ad = createSceneAdapter(createMockBackend()); ad.sync(scene);
  const u = [...ad.stats.unsupported];
  assert.ok(u.some((x) => /texture:map:compressed format 37808/.test(x)), u.join('|'));
  assert.ok(u.some((x) => /without mipmaps/.test(x)), u.join('|'));
  assert.ok(u.some((x) => /mip 1 size 3x/.test(x)), u.join('|'));
  assert.equal(ad.stats.unsupported.size, 3);
  // wasm side: old pkg + core error both recorded (id 0 white, no throw), via the wgpu backend drain into adapter stats
  for (const opts of [{ withCompressed: false }, { failWith: 'compressed format 99 not supported' }]) {
    const { backend } = await fakeWgpu(opts);
    const s2 = new THREE.Scene(); s2.add(new THREE.Mesh(tri(), new THREE.MeshStandardMaterial({ map: compressed(33776, 4, [bc1(RED)]) })));
    const ad2 = createSceneAdapter(backend); assert.doesNotThrow(() => ad2.sync(s2));
    assert.ok([...ad2.stats.unsupported].some((x) => /^texture:compressed 33776 4x4/.test(x)), [...ad2.stats.unsupported].join('|'));
  }
});

test('uncompressed unreadable image is recorded, not silent', () => {
  const t = new THREE.Texture({ width: 4, height: 4 }); t.needsUpdate = true; // present, not CPU-readable
  const p = materialToParams(new THREE.MeshStandardMaterial({ map: t }));
  assert.ok(p.unsupported?.[0]?.startsWith('texture:map:image not CPU-readable'));
});

test('idle frames: compressed texture is described once (key cache), zero re-uploads', async () => {
  const { c, backend } = await fakeWgpu();
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(tri(), new THREE.MeshStandardMaterial({ map: compressed(33776, 4, [bc1(RED)]) })));
  const ad = createSceneAdapter(backend);
  for (let f = 0; f < 5; f++) ad.sync(scene);
  assert.equal(c.comp.length, 1);
});
