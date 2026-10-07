// r10-shadow-4: TSL packages carry three's PER-OBJECT receiveShadow (stand-in Mesh for instanced/skinned; variant export when users differ).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { exportNodeMaterial } from '../client/kernel/render-api/tsl-export.js';
import { createSceneAdapter } from '../client/kernel/render-api/scene-adapter.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';

const tri = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)); return g; };
const sunScene = () => { const s = new THREE.Scene(); const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(0, 10, 0); sun.castShadow = true; s.add(sun); return s; };
const tslMat = () => { const m = new THREE.MeshStandardNodeMaterial(); m.colorNode = color(0xff8800); return m; };
const hasShadow = (pkg) => `${pkg.vertex}\n${pkg.fragment}`.includes('gaia_sun_shadow');

test('stand-in mesh (geometry path) takes receiveShadow from options, never a global true', () => {
  const scene = sunScene(), m = tslMat();
  assert.ok(hasShadow(exportNodeMaterial(m, { THREE, geometry: tri(), scene, receiveShadow: true })), 'receiver package has gaia_sun_shadow');
  assert.ok(!hasShadow(exportNodeMaterial(tslMat(), { THREE, geometry: tri(), scene, receiveShadow: false })), 'non-receiver has none');
  assert.ok(!hasShadow(exportNodeMaterial(tslMat(), { THREE, geometry: tri(), scene })), 'default = three default (false)');
});

test('real object: its own receiveShadow decides, and the flag is not mutated', () => {
  const scene = sunScene(), mesh = new THREE.Mesh(tri(), tslMat()); mesh.receiveShadow = true;
  assert.ok(hasShadow(exportNodeMaterial(mesh.material, { THREE, object: mesh, scene })));
  assert.equal(mesh.receiveShadow, true);
  const m2 = new THREE.Mesh(tri(), tslMat());
  assert.ok(!hasShadow(exportNodeMaterial(m2.material, { THREE, object: m2, scene })));
  assert.equal(m2.receiveShadow, false);
});

test('adapter: one material, receiver + non-receiver (plain + instanced) → distinct exports keyed by receiveShadow', () => {
  const scene = sunScene(), m = tslMat(), g = tri();
  const a = new THREE.Mesh(g, m); a.receiveShadow = true;
  const b = new THREE.Mesh(g, m); b.receiveShadow = false; b.position.x = 3;
  const inst = new THREE.InstancedMesh(g, m, 2); inst.receiveShadow = true; inst.position.y = 4;
  const be = createMockBackend(); const pkgs = [];
  const orig = be.createShaderMaterial?.bind(be); be.createShaderMaterial = (p) => { pkgs.push(p); return orig ? orig(p) : pkgs.length; };
  scene.add(a, b, inst);
  const ad = createSceneAdapter(be, { three: THREE, exportNodeMaterial, tslOptions: { THREE }, recvVariants: true });
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.position.set(0, 0, 5);
  ad.sync(scene, cam);
  assert.equal(pkgs.length, 2, 'two exports for one material');
  assert.equal(pkgs.filter(hasShadow).length, 1, 'exactly the receiver variant carries gaia_sun_shadow (instanced stand-in shares it)');
  ad.sync(scene, cam); // idle: no re-export
  assert.equal(pkgs.length, 2); assert.equal(ad.stats.tsl.shadowReceivers, 1, "adapter counts receiver packages");
});

test('r10-shadow-5: shared material, NON-receiver visited first → package still becomes a receiver once ANY user receives (latch, 1 re-export, idle stable)', () => {
  const scene = sunScene(), m = tslMat(), g = tri();
  const first = new THREE.Mesh(g, m); first.receiveShadow = false;
  const second = new THREE.Mesh(g, m); second.receiveShadow = true; second.position.x = 3;
  scene.add(first, second);
  const be = createMockBackend(); const pkgs = [];
  const orig = be.createShaderMaterial?.bind(be); be.createShaderMaterial = (p) => { pkgs.push(p); return orig ? orig(p) : pkgs.length; };
  const ad = createSceneAdapter(be, { three: THREE, exportNodeMaterial, tslOptions: { THREE } }); // default: variants OFF
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.position.set(0, 0, 5);
  ad.sync(scene, cam);
  assert.ok(!hasShadow(pkgs[0]), 'frame 1: exported from the non-receiver first user (the old, wrong, final state)');
  ad.sync(scene, cam); const n = pkgs.length;
  assert.ok(hasShadow(pkgs[n - 1]), 'latched package has the hook');
  assert.ok(n <= 2, 'at most one re-export');
  ad.sync(scene, cam); assert.equal(pkgs.length, n, 'idle: no further export');
  assert.equal(ad.matInfo(m).shadow, true);
});
