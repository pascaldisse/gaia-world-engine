// r6-scene: fog / scene.environment (SH9 diffuse IBL) / background Texture+Cube through scene-adapter → backend (recording mock).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';
import { readCube, readTexture, shIrradiance, evalSh } from '../client/kernel/render-api/env-image.js';

const OPT = ['setAmbient', 'setBackground', 'setBackgroundTexture', 'setFog', 'setEnvironment'];
const mk = () => { const be = createMockBackend({ optional: OPT }); return { be, ad: createSceneAdapter(be) }; };
const call = (be, n) => be.log.filter((c) => c[0] === n);
const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const faceData = (n, f) => Uint8Array.from({ length: n * n * 4 }, (_, i) => (i % 4 === 3 ? 255 : f(i % 4)));
const cube = (n, f) => { const t = new THREE.CubeTexture([0, 1, 2, 3, 4, 5].map((k) => ({ data: faceData(n, (c) => f(k, c)), width: n, height: n }))); t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t; };

test('Fog / FogExp2 → setFog (linear colour, params), idle = 0 calls, per-frame animation = 1 call, removal → null', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x336699, 10, 100); ad.sync(scene);
  const [c] = call(be, 'setFog'); assert.equal(c[1].mode, 1); assert.equal(c[1].near, 10); assert.equal(c[1].far, 100);
  near(c[1].color[0], scene.fog.color.r); near(c[1].color[2], scene.fog.color.b);
  be.take(); ad.sync(scene); assert.equal(call(be, 'setFog').length, 0);
  scene.fog.far = 200; ad.sync(scene); assert.equal(call(be, 'setFog').length, 1);
  scene.fog = new THREE.FogExp2(0xffffff, 0.01); ad.sync(scene); assert.equal(call(be, 'setFog').slice(-1)[0][1].mode, 2); near(call(be, 'setFog').slice(-1)[0][1].density, 0.01);
  scene.fog = null; ad.sync(scene); assert.equal(call(be, 'setFog').slice(-1)[0][1], null);
});

test('SH9 irradiance: uniform white cube → E/π = 1 everywhere; sky-white/ground-black cube → n.y=+1 bright, -1 dark, monotone', () => {
  const flat = readCube(cube(8, () => 255)); const sh = shIrradiance(flat);
  for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1]]) evalSh(sh, n).forEach((v) => near(v, 1, 0.02));
  // +Y face (index 2) white, −Y face (3) black, sides gray 0.5
  const c = readCube(cube(16, (k) => (k === 2 ? 255 : k === 3 ? 0 : 128))); const s2 = shIrradiance(c);
  const up = evalSh(s2, [0, 1, 0])[0], dn = evalSh(s2, [0, -1, 0])[0], sd = evalSh(s2, [1, 0, 0])[0];
  assert.ok(up > sd && sd > dn, `${up} ${sd} ${dn}`);
  // cube X-flip: world +X side (texel face −X lookup flipped) — put bright on face 0 (+X lookup) → world −X is bright (three flipEnvMap)
  const c3 = readCube(cube(16, (k) => (k === 0 ? 255 : 0))); const s3 = shIrradiance(c3);
  assert.ok(evalSh(s3, [-1, 0, 0])[0] > evalSh(s3, [1, 0, 0])[0], 'face +X lookup lands on world −X');
});

test('equirect SH: top rows bright → +Y bright (rows top-first, DataTexture flipY=false is reversed)', () => {
  const w = 32, h = 16; const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const v = y >= h / 2 ? 255 : 0; data.set([v, v, v, 255], i); } // GL order: row 0 = bottom → upper half of data = TOP of sky
  const t = new THREE.DataTexture(data, w, h); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  const r = readTexture(t); assert.equal(r.rgba8[0], 255, 'first top-first row is the bright one');
  const sh = shIrradiance(r, { equirect: true }); assert.ok(evalSh(sh, [0, 1, 0])[0] > evalSh(sh, [0, -1, 0])[0] * 3);
});

test('scene.environment → setEnvironment {sh27, intensity}; removal → null; idle 0 calls; unreadable → loud unsupported', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  scene.environment = cube(8, () => 255); scene.environmentIntensity = 0.5; ad.sync(scene);
  const [c] = call(be, 'setEnvironment'); assert.equal(c[1].sh.length, 27); assert.equal(c[1].intensity, 0.5);
  be.take(); ad.sync(scene); assert.equal(call(be, 'setEnvironment').length, 0);
  scene.environment = null; ad.sync(scene); assert.equal(call(be, 'setEnvironment').slice(-1)[0][1], null);
  const rt = new THREE.Texture(); rt.isRenderTargetTexture = true; rt.mapping = THREE.EquirectangularReflectionMapping; scene.environment = rt; ad.sync(scene);
  assert.ok([...ad.stats.unsupported].some((u) => u.startsWith('environment:')));
});

test('scene.background CubeTexture/Texture → setBackgroundTexture; Color afterwards → setBackground', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  scene.background = cube(4, (k) => k * 40); ad.sync(scene);
  let [c] = call(be, 'setBackgroundTexture'); assert.equal(c[1].kind, 'cube'); assert.equal(c[1].rgba.length, 6 * 4 * 4 * 4);
  const t = new THREE.DataTexture(new Uint8Array(4 * 2 * 4).fill(200), 4, 2); t.needsUpdate = true; scene.background = t; ad.sync(scene);
  [c] = call(be, 'setBackgroundTexture').slice(-1); assert.equal(c[1].kind, 'screen');
  t.mapping = THREE.EquirectangularReflectionMapping; t.version++; ad.sync(scene); assert.equal(call(be, 'setBackgroundTexture').slice(-1)[0][1].kind, 'equirect');
  scene.background = new THREE.Color(0x102030); ad.sync(scene); assert.equal(call(be, 'setBackground').length >= 1, true);
  assert.ok(![...ad.stats.unsupported].some((u) => u.startsWith('background')));
});

test('backend without the new methods: fog/environment loudly unsupported', () => {
  const be = createMockBackend(); const ad = createSceneAdapter(be); const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 10); scene.environment = cube(4, () => 255); ad.sync(scene);
  assert.ok(ad.stats.unsupported.has('fog') && ad.stats.unsupported.has('environment'));
});
