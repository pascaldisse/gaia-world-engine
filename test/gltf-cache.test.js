// § mountGltf per-URL template cache: one load per src, shared geometry/textures, per-instance materials, safe dispose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.location = { hostname: 'localhost', search: '' };
globalThis.__GAIA_PORT__ = '8420';
const { mountGltf, disposeGltf, releaseGltf, _gltfTemplateCache } = await import('../client/kernel/gltf.js');

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
  const loader = fakeLoader(), g1 = host(), keeper = await mountGltf(host(), { src: 'm.gltf' }, 1, () => {}, { loader }); // keeper = another live instance (sole-instance dispose now evicts — see evict tests)
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

test('stale token → instance dropped (null), template kept while another instance lives (evicted with the last — see evict tests)', async () => {
  const loader = fakeLoader(), g = host(), live = await mountGltf(host(), { src: 's.gltf' }, 1, () => {}, { loader });
  const pending = mountGltf(g, { src: 's.gltf' }, 1, () => {}, { loader }); g.userData.gltfToken = 2;
  assert.equal(await pending, null); assert.equal(g.children.length, 0);
  assert.ok(_gltfTemplateCache.has(loader, new URL('s.gltf', 'http://localhost:8420/').href));
  disposeGltf(live);
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

// § refcount eviction (lampas/gltf-cache-evict): lease per instance (taken when mountGltf starts, so in-flight mounts pin the entry) → last release frees template + shared geometry/textures.
const U = src => new URL(src, 'http://localhost:8420/').href;
const count = (obj, ev = 'dispose') => { const c = { n: 0 }; obj.addEventListener(ev, () => c.n++); return c; };
const sharedOf = r => { const m = mesh(r); return { geometry: m.geometry, texture: m.material.map }; };

test('evict: last disposeGltf frees template + shared geometry/texture exactly once; cache empties', async () => {
  const loader = fakeLoader(), roots = await Promise.all([host(), host(), host()].map(g => mountGltf(g, { src: 'e.gltf' }, 1, () => {}, { loader })));
  const { geometry, texture } = sharedOf(roots[0]), gd = count(geometry), td = count(texture), url = U('e.gltf');
  disposeGltf(roots[0]); disposeGltf(roots[1]);
  assert.ok(_gltfTemplateCache.has(loader, url), 'two of three released → template still cached');
  assert.deepEqual([gd.n, td.n], [0, 0], 'shared resources alive while an instance lives');
  const late = await mountGltf(host(), { src: 'e.gltf' }, 1, () => {}, { loader });
  assert.equal(mesh(late).geometry, geometry); assert.equal(loader.calls.length, 1, 'live template still shared by a late mount');
  disposeGltf(roots[2]); assert.ok(_gltfTemplateCache.has(loader, url), 'late mount keeps it alive');
  disposeGltf(late);
  assert.equal(_gltfTemplateCache.has(loader, url), false, 'all instances disposed → entry evicted');
  assert.equal(_gltfTemplateCache.size(loader), 0);
  assert.deepEqual([gd.n, td.n], [1, 1], 'shared geometry + texture disposed exactly once');
  const again = await mountGltf(host(), { src: 'e.gltf' }, 1, () => {}, { loader });
  assert.equal(loader.calls.length, 2, 'after eviction a mount reloads'); assert.notEqual(mesh(again).geometry, geometry);
  assert.equal(mesh(again).geometry.userData.shared, true); assert.equal(mesh(again).material.map.userData.shared, true);
  assert.notEqual(mesh(again).material, mesh(late).material);
});

test('evict: disposeGltf/releaseGltf are idempotent per instance (double dispose never steals another instance\'s ref)', async () => {
  const loader = fakeLoader(), [a, b] = await Promise.all([host(), host()].map(g => mountGltf(g, { src: 'i.gltf' }, 1, () => {}, { loader })));
  const gd = count(mesh(a).geometry);
  disposeGltf(a); disposeGltf(a); releaseGltf(a);
  assert.ok(_gltfTemplateCache.has(loader, U('i.gltf'))); assert.equal(gd.n, 0);
  releaseGltf(b); assert.equal(_gltfTemplateCache.has(loader, U('i.gltf')), false); assert.equal(gd.n, 1);
});

test('evict: in-flight dedup + in-flight pin — a stale mount releasing does not evict while another mount awaits the same load', async () => {
  const loader = fakeLoader(), g1 = host(), g2 = host();
  const p1 = mountGltf(g1, { src: 'p.gltf' }, 1, () => {}, { loader }), p2 = mountGltf(g2, { src: 'p.gltf' }, 1, () => {}, { loader });
  g1.userData.gltfToken = 2;
  assert.equal(await p1, null); const r2 = await p2;
  assert.ok(r2); assert.equal(loader.calls.length, 1); assert.ok(_gltfTemplateCache.has(loader, U('p.gltf')));
  const gd = count(mesh(r2).geometry); disposeGltf(r2);
  assert.equal(gd.n, 1); assert.equal(_gltfTemplateCache.size(loader), 0);
});

test('evict: every mount stale before the load settles → template freed once the load lands (no orphan)', async () => {
  const loader = fakeLoader(), g = host(), p = mountGltf(g, { src: 'o.gltf' }, 1, () => {}, { loader }); g.userData.gltfToken = 2;
  assert.equal(await p, null);
  assert.equal(_gltfTemplateCache.has(loader, U('o.gltf')), false); assert.equal(_gltfTemplateCache.size(loader), 0);
});

test('evict: failed load leaves no entry and no lease (retry works, later dispose is clean)', async () => {
  const loader = fakeLoader({ fail: 1 }), err = console.error; console.error = () => {};
  try {
    assert.equal(await mountGltf(host(), { src: 'x.gltf' }, 1, () => {}, { loader }), null);
    assert.equal(_gltfTemplateCache.size(loader), 0);
    const r = await mountGltf(host(), { src: 'x.gltf' }, 1, () => {}, { loader }); assert.ok(r);
    disposeGltf(r); assert.equal(_gltfTemplateCache.size(loader), 0);
  } finally { console.error = err; }
});

test('evict: per-URL refcounts are independent', async () => {
  const loader = fakeLoader(), a = await mountGltf(host(), { src: 'a.gltf' }, 1, () => {}, { loader }), b = await mountGltf(host(), { src: 'b.gltf' }, 1, () => {}, { loader });
  disposeGltf(a);
  assert.equal(_gltfTemplateCache.has(loader, U('a.gltf')), false); assert.ok(_gltfTemplateCache.has(loader, U('b.gltf')));
  disposeGltf(b); assert.equal(_gltfTemplateCache.size(loader), 0);
});

// § OWNERSHIP with a game that frees shared resources itself (EE client/animation.js watchAlternateResources: listener-guarded `if (!disposed) resource.dispose()` by the LAST of ITS live alternates).
//   Rule: engine frees a template's shared geometry/textures at lease-count 0 UNLESS they already fired 'dispose' since the last acquire (game freed them) → no second dispose event; and if the engine
//   frees first, the game's own guard sees the event and skips. Neither side ever frees a resource a live lease holds (game excludes primary-borrowed resources; engine counts every instance).
test('ownership: game early-free of shared resources → engine eviction does not dispose them again; engine-first eviction is seen by the game guard', async () => {
  const loader = fakeLoader(), r = await mountGltf(host(), { src: 'g.gltf' }, 1, () => {}, { loader }), { geometry, texture } = sharedOf(r);
  const gd = count(geometry), td = count(texture);
  geometry.dispose(); texture.dispose();            // game: last alternate released → frees shared resources itself
  assert.deepEqual([gd.n, td.n], [1, 1]);
  disposeGltf(r);                                   // engine: last lease → evict
  assert.deepEqual([gd.n, td.n], [1, 1], 'no double dispose of what the game already freed');
  assert.equal(_gltfTemplateCache.size(loader), 0);
  const r2 = await mountGltf(host(), { src: 'g2.gltf' }, 1, () => {}, { loader }), s2 = sharedOf(r2), g2 = count(s2.geometry);
  let gameSaw = false; s2.geometry.addEventListener('dispose', () => { gameSaw = true; });
  disposeGltf(r2);                                  // engine frees first
  assert.equal(g2.n, 1); assert.ok(gameSaw, 'game listener-guard observes the engine free (it then skips its own dispose)');
});

test('ownership: a resource the game freed, then re-acquired by a new mount, is freed again at eviction (re-upload must not leak)', async () => {
  const loader = fakeLoader(), a = await mountGltf(host(), { src: 'h.gltf' }, 1, () => {}, { loader }), { geometry } = sharedOf(a), gd = count(geometry);
  geometry.dispose();                               // game early-free (n=1)
  const b = await mountGltf(host(), { src: 'h.gltf' }, 1, () => {}, { loader });   // same live template, resource in use again
  assert.equal(mesh(b).geometry, geometry);
  disposeGltf(a); disposeGltf(b);
  assert.equal(gd.n, 2, 'engine disposes at eviction because a new acquire reset the freed-flag');
});
