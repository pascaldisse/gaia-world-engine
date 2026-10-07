// r12-water: three CubeTexture (static) through a TSL cubeTexture() node → texture-cube binding → gpu.createTextureCube (6 faces, three's WebGPU face order, sRGB flag, refcounted by uuid:cube:version).
// Render-target cube (CubeCamera) + unreadable faces = LOUD refusal. scene.background CubeTexture keeps its own path (render-api-scene-env.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { cubeTexture, vec3, positionWorld } from 'three/tsl';
import { exportNodeMaterial } from '../client/kernel/render-api/tsl-export.js';
import { cubeTextureData } from '../client/kernel/render-api/material-map.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

const N = 2;
const FACE = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
const face = (c) => { const d = new Uint8Array(N * N * 4); for (let i = 0; i < N * N; i++) d.set([...c, 255], i * 4); return new THREE.DataTexture(d, N, N); };
const makeCube = (srgb = true) => { const t = new THREE.CubeTexture(FACE.map((c) => face(c).image)); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t; };

async function fakeWgpu() {
  const c = { calls: [], mats: [], destroyed: [] }; let id = 0;
  const gpu = { hasTimestamps: () => false, createTextureCube: (...a) => { c.calls.push(['cube', ...a]); return ++id; }, destroyTexture: (i) => c.destroyed.push(i),
    createThreeMaterial: (json, names, ids) => { c.mats.push({ names: [...names], ids: [...ids] }); return 100 + c.mats.length; }, destroyMaterial() {} };
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpu } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { c, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}

test('cubeTextureData: 6 faces face-major RGBA8, srgb flag, cached per version, version bump → new key', () => {
  const t = makeCube(true), d = cubeTextureData(t);
  assert.equal(d.size, N); assert.equal(d.srgb, true); assert.equal(d.data.length, 6 * N * N * 4);
  for (let f = 0; f < 6; f++) assert.deepEqual([...d.data.subarray(f * N * N * 4, f * N * N * 4 + 3)], FACE[f], `face ${f} order +X -X +Y -Y +Z -Z`);
  assert.equal(cubeTextureData(t), d, 'same descriptor while version unchanged');
  t.needsUpdate = true; assert.notEqual(cubeTextureData(t).key, d.key);
  assert.equal(cubeTextureData(makeCube(false)).srgb, false);
});

test('cubeTextureData: render-target cube (CubeCamera) and unreadable faces are loud refusals', () => {
  const rt = new THREE.RenderTarget(16, 16); rt.texture.isCubeTexture = true; // CubeCamera target texture: isRenderTargetTexture, no readable faces
  assert.match(cubeTextureData(rt.texture).refused, /render-target cube.*CubeCamera/);
  const bad = new THREE.CubeTexture([null, null, null, null, null, null]);
  assert.ok(cubeTextureData(bad).refused, 'unreadable → refused, not thrown');
});

test('TSL cubeTexture() NodeMaterial → texture-cube binding → createTextureCube once (shared), bound by binding name', async () => {
  const cube = makeCube(true);
  const mk = () => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = cubeTexture(cube, vec3(positionWorld.x.negate(), positionWorld.y, positionWorld.z)).rgb; return m; };
  const pkg = exportNodeMaterial(mk(), { THREE });
  const bd = pkg.bindGroups.flatMap((g) => g.bindings).find((b) => b.kind === 'texture-cube');
  assert.ok(bd, 'export produced a texture-cube binding'); assert.equal(pkg.textureSources[bd.textureUuid], cube);
  assert.match(pkg.fragment, /texture_cube<f32>/);
  const { c, backend } = await fakeWgpu();
  const a = backend.createShaderMaterial(pkg), b = backend.createShaderMaterial(exportNodeMaterial(mk(), { THREE }));
  assert.notEqual(a, b);
  const cubes = c.calls.filter((x) => x[0] === 'cube');
  assert.equal(cubes.length, 1, 'one GPU cube shared by both materials');
  assert.equal(cubes[0][1], N); assert.equal(cubes[0][2].length, 6 * N * N * 4); assert.equal(cubes[0][3], true, 'sRGB cube');
  assert.deepEqual(c.mats[0].names, [bd.name]); assert.equal(c.mats[0].ids[0], c.mats[1].ids[0]);
});

test('createShaderMaterial: render-target cube texture (dynamic) throws loud; no GPU cube created', async () => {
  const rt = new THREE.RenderTarget(16, 16); rt.texture.isCubeTexture = true; // CubeCamera target texture: isRenderTargetTexture, no readable faces
  const pkg = { vertex: 'v', fragment: 'f', bindGroups: [{ group: 0, bindings: [{ binding: 0, name: 'envTex', kind: 'texture-cube', textureUuid: rt.texture.uuid }] }] };
  Object.defineProperty(pkg, 'textureSources', { value: { [rt.texture.uuid]: rt.texture }, enumerable: false });
  const { c, backend } = await fakeWgpu();
  assert.throws(() => backend.createShaderMaterial(pkg), /texture cube 'envTex'.*render-target cube/);
  assert.equal(c.calls.length, 0);
});
