// r6 S1/S2: Hemisphere/Ambient lights + scene.background through scene-adapter → backend.setAmbient/setBackground (recording mock).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';

const OPT = ['updateMesh', 'updateMaterial', 'createInstanced', 'updateInstances', 'createShaderMaterial', 'setAmbient', 'setBackground'];
const mk = () => { const be = createMockBackend({ optional: OPT }); return { be, ad: createSceneAdapter(be) }; };
const call = (be, n) => be.log.filter((c) => c[0] === n);
const close = (a, b) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), `${a} != ${b}`);

test('HemisphereLight → setAmbient {sky,ground} = colour × intensity (linear, three Color r/g/b)', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  const h = new THREE.HemisphereLight(0x00ff00, 0xff0000, 2); scene.add(h);
  ad.sync(scene);
  const [c] = call(be, 'setAmbient'); assert.ok(c, 'setAmbient called');
  close(c[1].sky, [h.color.r * 2, h.color.g * 2, h.color.b * 2]); close(c[1].ground, [h.groundColor.r * 2, h.groundColor.g * 2, h.groundColor.b * 2]);
  assert.ok(!ad.stats.unsupported.has('light:HemisphereLight'));
  be.take(); ad.sync(scene); assert.deepEqual(call(be, 'setAmbient'), [], 'idle frame = no call');
  h.intensity = 1; ad.sync(scene); assert.equal(call(be, 'setAmbient').length, 1, 'intensity change = one call');
});

test('AmbientLight folds into sky AND ground; lights sum; invisible light dropped; removal → zeros', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  const a = new THREE.AmbientLight(0xffffff, 0.5); scene.add(a);
  const h = new THREE.HemisphereLight(0xffffff, 0x000000, 1); scene.add(h);
  ad.sync(scene);
  let [c] = call(be, 'setAmbient').slice(-1);
  close(c[1].sky, [1.5, 1.5, 1.5]); close(c[1].ground, [0.5, 0.5, 0.5]);
  h.visible = false; ad.sync(scene); [c] = call(be, 'setAmbient').slice(-1); close(c[1].sky, [0.5, 0.5, 0.5]);
  scene.remove(a); scene.remove(h); ad.sync(scene); [c] = call(be, 'setAmbient').slice(-1); close(c[1].sky, [0, 0, 0]); close(c[1].ground, [0, 0, 0]);
});

test('backend without setAmbient: Hemisphere/Ambient stay loudly unsupported (old behaviour)', () => {
  const be = createMockBackend(); const ad = createSceneAdapter(be); const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1), new THREE.AmbientLight(0xffffff, 1));
  ad.sync(scene);
  assert.ok(ad.stats.unsupported.has('light:HemisphereLight') && ad.stats.unsupported.has('light:AmbientLight'));
});

test('non +Y hemisphere direction is flagged degraded', () => {
  const { ad } = mk(); const scene = new THREE.Scene(); const h = new THREE.HemisphereLight(); h.position.set(1, 0, 0); scene.add(h);
  ad.sync(scene); assert.ok([...ad.stats.degraded].some((d) => d.startsWith('HemisphereLight-direction')));
});

test('scene.background Color → setBackground(linear rgb); change tracked; null → black; Texture/Cube → unsupported, never throws', () => {
  const { be, ad } = mk(); const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x336699);
  ad.sync(scene);
  let [c] = call(be, 'setBackground'); close(c[1], [scene.background.r, scene.background.g, scene.background.b]);
  assert.ok(c[1][2] > c[1][0], 'bluish'); // linear values (0x33→0.033 …), NOT raw 0.2
  assert.ok(Math.abs(c[1][0] - 0x33 / 255) > 0.05, 'converted sRGB → linear, not raw');
  be.take(); ad.sync(scene); assert.deepEqual(call(be, 'setBackground'), []);
  scene.background.set(0xff0000); ad.sync(scene); assert.equal(call(be, 'setBackground').length, 1);
  scene.background = null; ad.sync(scene); [c] = call(be, 'setBackground').slice(-1); assert.deepEqual(c[1], null);
  const before = call(be, 'setBackground').length;
  scene.background = new THREE.Texture(); ad.sync(scene);
  assert.ok(ad.stats.unsupported.has('background:Texture')); assert.equal(call(be, 'setBackground').length, before, 'texture bg leaves clear colour alone');
  scene.background = new THREE.CubeTexture(); ad.sync(scene); assert.ok(ad.stats.unsupported.has('background:CubeTexture'));
});
