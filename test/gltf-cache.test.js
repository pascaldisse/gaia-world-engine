// § mountGltf per-URL template cache: one load per src, shared geometry/textures, per-instance materials, safe dispose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.location = { hostname: 'localhost', search: '' };
globalThis.__GAIA_PORT__ = '8420';
const { mountGltf, disposeGltf, _gltfTemplateCache } = await import('../client/kernel/gltf.js');

function fakeLoader({ fail = 0 } = {}) {
  const calls = [];
  return { calls, async loadAsync(url) {
    calls.push(url); await new Promise(r => setTimeout(r, 5));
    if (fail-- > 0) throw new Error('boom');
    const map = new THREE.Texture(), scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    return { scene, animations: [] };
  } };
}
const host = () => { const parent = new THREE.Group(), group = new THREE.Group(); parent.add(group); group.userData.gltfToken = 1; return group; };
const mesh = root => { let m; root.traverse(o => { if (o.isMesh) m = o; }); return m; };

test('N concurrent mounts of one src → ONE load; geometry+texture shared, material per instance', async () => {
  const loader = fakeLoader(), groups = Array.from({ length: 50 }, host);
  const roots = await Promise.all(groups.map(g => mountGltf(g, { src: 'models/tree.gltf', scale: 2 }, 1, () => {}, { loader })));
  assert.equal(loader.calls.length, 1);
  const [a, b] = roots.map(mesh);
  assert.equal(a.geometry, b.geometry); assert.equal(a.material.map, b.material.map);
  assert.notEqual(a.material, b.material);
  a.material.color.set(0xff0000); assert.notEqual(b.material.color.getHex(), 0xff0000);
  assert.ok(roots.every((r, i) => r.parent === groups[i] && r.scale.x === 2 && groups[i].userData.gltfStatus === 'ready'));
  assert.notEqual(roots[0], roots[1]);
});

test('disposeGltf frees instance materials only; later mounts still share the live template', async () => {
  const loader = fakeLoader(), g1 = host();
  const r1 = await mountGltf(g1, { src: 'm.gltf' }, 1, () => {}, { loader }), m1 = mesh(r1);
  let geometryDisposed = 0, textureDisposed = 0, materialDisposed = 0;
  m1.geometry.addEventListener('dispose', () => geometryDisposed++);
  m1.material.map.addEventListener('dispose', () => textureDisposed++);
  m1.material.addEventListener('dispose', () => materialDisposed++);
  disposeGltf(r1);
  assert.deepEqual([geometryDisposed, textureDisposed, materialDisposed], [0, 0, 1]);
  const r2 = await mountGltf(host(), { src: 'm.gltf' }, 1, () => {}, { loader });
  assert.equal(mesh(r2).geometry, m1.geometry); assert.equal(loader.calls.length, 1);
});

test('stale token → instance dropped (null), template kept', async () => {
  const loader = fakeLoader(), g = host();
  const pending = mountGltf(g, { src: 's.gltf' }, 1, () => {}, { loader }); g.userData.gltfToken = 2;
  assert.equal(await pending, null); assert.equal(g.children.length, 0);
  assert.ok(_gltfTemplateCache.has(loader, new URL('s.gltf', 'http://localhost:8420/').href));
});

test('failed load → error status, cache entry evicted, retry loads again', async () => {
  const loader = fakeLoader({ fail: 1 }), err = console.error; console.error = () => {};
  try {
    const g = host(); assert.equal(await mountGltf(g, { src: 'f.gltf' }, 1, () => {}, { loader }), null);
    assert.equal(g.userData.gltfStatus, 'error');
    const r = await mountGltf(host(), { src: 'f.gltf' }, 1, () => {}, { loader });
    assert.ok(r); assert.equal(loader.calls.length, 2);
  } finally { console.error = err; }
});

test('skinned template → each instance binds its OWN bones', async () => {
  const loader = { async loadAsync() {
    const bone = new THREE.Bone(), skeleton = new THREE.Skeleton([bone]), geometry = new THREE.BoxGeometry();
    const n = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => i % 4 ? 0 : 1), 4));
    const skinned = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial()), scene = new THREE.Group();
    skinned.add(bone); skinned.bind(skeleton); scene.add(skinned); return { scene };
  } };
  const [a, b] = await Promise.all([host(), host()].map(g => mountGltf(g, { src: 'k.gltf' }, 1, () => {}, { loader })));
  const sa = mesh(a), sb = mesh(b);
  assert.notEqual(sa.skeleton.bones[0], sb.skeleton.bones[0]);
  let inA = false; a.traverse(o => { if (o === sa.skeleton.bones[0]) inA = true; }); assert.ok(inA);
});
