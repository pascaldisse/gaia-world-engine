// Humanoid kit stage 5 — template-level piece merge (vertex conservation, joint remap), LOD, shared geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildBaseGlb, buildPieces, buildPieceGlb } from '../tools/humanoid-placeholder.mjs';
import { mergeSkinnedParts, normalizeLod, deriveLodUrl, lodLevelFor, resolveHumanoid } from '../shared/humanoid.js';
const { mountHumanoid, tickHumanoidLod, humanoidLodStats } = await import('../client/kernel/humanoid.js');

const PREFIX = '/assets/humanoid';
const files = new Map();
files.set(`${PREFIX}/base.glb`, buildBaseGlb());
for (const p of buildPieces()) files.set(`${PREFIX}/costume/${p.file}.glb`, buildPieceGlb(p));
const U = (rel) => `${PREFIX}/${rel}`;
const BASE = U('base.glb');
const OUTFIT = { head: U('costume/head/helmet.glb'), torso: U('costume/torso/armor.glb'), legs: U('costume/legs/trousers.glb'), feet: U('costume/feet/boots.glb') };
function makeLoader() {
  const real = new GLTFLoader();
  return { async loadAsync(url) { const buf = files.get(url); if (!buf) throw new Error(`404 ${url}`); return real.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); } };
}
const deps = (loader) => ({ loader, resolveUrl: (u) => u, fetchJson: async () => ({}) });
const mount = async (spec, loader = makeLoader()) => {
  const parent = new THREE.Group(), g = new THREE.Group(); parent.add(g); g.userData.humanoidToken = 1;
  const root = await mountHumanoid(g, spec, 1, () => {}, deps(loader)); g.updateMatrixWorld(true);
  return { g, root, h: root?.userData.humanoid };
};
const skinnedOf = (root) => { const out = []; root.traverse((o) => o.isSkinnedMesh && out.push(o)); return out; };
function restError(mesh) {
  const v = new THREE.Vector3(), pos = mesh.geometry.attributes.position;
  let err = 0;
  for (let i = 0; i < pos.count; i++) { mesh.getVertexPosition(i, v); err = Math.max(err, Math.abs(v.x - pos.getX(i)), Math.abs(v.y - pos.getY(i)), Math.abs(v.z - pos.getZ(i))); }
  return err;
}

test('mergeSkinnedParts: vertex/index count conserved, indices offset, joints remapped onto ONE table', () => {
  const A = { position: Float32Array.from({ length: 9 }, (_, i) => i + 1), skinIndex: new Float32Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]), skinWeight: new Float32Array([.5, .5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), index: new Uint16Array([0, 1, 2]), jointKeys: ['hips', 'spine'], uv: new Float32Array(6) };
  const B = { position: Float32Array.from({ length: 12 }, (_, i) => 100 + i), skinIndex: new Float32Array([0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), skinWeight: new Float32Array([.25, .75, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), index: new Uint16Array([0, 1, 2, 2, 1, 3]), jointKeys: ['spine', 'head', 'hips'] };
  const m = mergeSkinnedParts([A, B]);
  assert.equal(m.vertexCount, 3 + 4);
  assert.equal(m.position.length, 7 * 3);
  assert.deepEqual([...m.position], [...A.position, ...B.position], 'positions concatenated verbatim');
  assert.equal(m.indexCount, 3 + 6);
  assert.deepEqual(m.jointKeys, ['hips', 'spine', 'head']);            // deduped, first-seen order
  assert.deepEqual([...m.jointMaps[0]], [0, 1]);
  assert.deepEqual([...m.jointMaps[1]], [1, 2, 0]);                     // spine->1, head->2, hips->0
  assert.deepEqual([...m.index], [0, 1, 2, 3, 4, 5, 5, 4, 6]);          // B indices offset by A's 3 vertices
  // vertex 0 of A: weights on hips(0)+spine(1) unchanged; vertex 0 of B (merged 3): spine(0)->1, head(1)->2
  assert.deepEqual([...m.skinIndex.slice(0, 2)], [0, 1]);
  assert.deepEqual([...m.skinIndex.slice(12, 14)], [1, 2]);
  assert.equal(m.skinIndex[4 * 4], 0 /* B v1: joint 2 'hips' -> 0 */);
  assert.deepEqual([...m.ranges.map((r) => [r.vertexStart, r.vertexCount])], [[0, 3], [3, 4]]);
  assert.ok(m.uv && m.uv.length === 14 && !m.normal, 'uv present in only one part => zero-filled, no normal');
  m.position[0] = 9; assert.equal(A.position[0], 1, 'copied, never aliased');
});

test('merged mount: skinned meshes collapse to ONE per material; vertex count == sum of per-piece; rest pose exact (joint remap correct)', async () => {
  const loader = makeLoader();
  const split = await mount({ base: BASE, merge: false, costume: OUTFIT }, loader);
  const merged = await mount({ base: BASE, costume: OUTFIT }, loader);
  const verts = (root) => skinnedOf(root).reduce((s, m) => s + m.geometry.attributes.position.count, 0);
  const mats = new Set(skinnedOf(split.root).map((m) => m.material.uuid));
  assert.ok(skinnedOf(split.root).length >= 5, 'baseline has many skinned meshes');
  assert.equal(skinnedOf(merged.root).length, mats.size, 'one skinned mesh per distinct material');
  assert.equal(verts(merged.root), verts(split.root), 'vertex count conserved');
  const idx = (root) => skinnedOf(root).reduce((s, m) => s + m.geometry.index.count, 0);
  assert.equal(idx(merged.root), idx(split.root), 'index count conserved');
  for (const m of skinnedOf(merged.root)) assert.ok(restError(m) < 1e-5, `merged rest error ${restError(m)}`);
  // every merged joint is a node of THIS instance; helmet+armor bones follow the instance skeleton
  const nodes = new Set(); merged.root.traverse((o) => nodes.add(o));
  for (const m of skinnedOf(merged.root)) for (const b of m.skeleton.bones) assert.ok(nodes.has(b), `bone ${b.name} belongs to the instance`);
  const before = skinnedOf(merged.root).map((m) => restError(m));
  merged.h.bones.get('upperChest').rotation.x = 0.6; merged.g.updateMatrixWorld(true);
  assert.ok(skinnedOf(merged.root).some((m, i) => restError(m) > before[i] + 0.01), 'merged verts follow the bones');
  assert.equal(merged.h.merged.drawsPerLevel0, skinnedOf(merged.root).length);
  assert.deepEqual(merged.h.report, { drift: [], unmapped: [], failed: [] });
});

test('merged mount shares ONE merged geometry across instances; params + colors still apply', async () => {
  const loader = makeLoader();
  const a = await mount({ base: BASE, costume: OUTFIT, colors: { primary: '#ff0000' }, params: { legLength: 1.2 } }, loader);
  const b = await mount({ base: BASE, costume: OUTFIT, colors: { primary: '#0000ff' } }, loader);
  const ga = skinnedOf(a.root).map((m) => m.geometry), gb = skinnedOf(b.root).map((m) => m.geometry);
  assert.deepEqual(ga, gb, 'same merged geometry objects');
  assert.ok(ga.every((g) => g.userData.shared));
  assert.notEqual(skinnedOf(a.root)[0].skeleton, skinnedOf(b.root)[0].skeleton, 'skeleton per instance');
  assert.ok(a.h.bones.get('leftUpperLeg').scale.length() > b.h.bones.get('leftUpperLeg').scale.length(), 'legLength param applied');
  a.h.release(); b.h.release();
});

test('LOD helpers: derive urls, normalize, hysteresis', () => {
  assert.equal(deriveLodUrl('assets/ee/ee_clubman.gltf', 1), 'assets/ee/ee_clubman_lod1.gltf');
  assert.equal(deriveLodUrl('http://h/x.glb?v=2', 2), 'http://h/x_lod2.glb?v=2');
  assert.equal(normalizeLod(false), null);
  assert.deepEqual(normalizeLod(true).distances, [25, 60]);
  assert.deepEqual(normalizeLod({ distances: [40, 10] }).distances, [10, 40]);
  assert.equal(normalizeLod({ bases: ['a'] }).count, 1);
  assert.equal(lodLevelFor(5, [10, 30]), 0);
  assert.equal(lodLevelFor(15, [10, 30]), 1);
  assert.equal(lodLevelFor(99, [10, 30]), 2);
  assert.equal(lodLevelFor(10.2, [10, 30], 0, 0.08), 0, 'inside the hysteresis band: stay');
  assert.equal(lodLevelFor(9.5, [10, 30], 1, 0.08), 1, 'back across the edge: stay');
  assert.equal(lodLevelFor(8, [10, 30], 1, 0.08), 0);
  assert.equal(resolveHumanoid({ base: 'b', lod: true }).render.merge, true);
  assert.equal(resolveHumanoid({ base: 'b', merge: false }).render.merge, false);
  assert.equal(resolveHumanoid({ base: 'b', lod: true }).key, resolveHumanoid({ base: 'b' }).key, 'render options are not unit identity');
});

test('LOD mount: levels are hidden/shown by camera distance; missing level is skipped, not fatal; release unregisters', async () => {
  const loader = makeLoader();
  const { g, root, h } = await mount({ base: BASE, costume: OUTFIT, lod: { bases: [BASE, U('nope.glb')], distances: [10, 30] } }, loader);
  assert.ok(root, 'mounted despite the 404 level');
  assert.equal(h.report.lod.length, 1);
  assert.equal(h.lod.groups.length, 2);
  assert.deepEqual(h.lod.groups.map((x) => x.visible), [true, false]);
  const cam = new THREE.PerspectiveCamera(); const here = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
  cam.position.copy(here).add(new THREE.Vector3(0, 0, 20)); cam.updateMatrixWorld(true);
  tickHumanoidLod(cam);
  assert.deepEqual(h.lod.groups.map((x) => x.visible), [false, true]);
  assert.ok(humanoidLodStats().perLevel[1] >= 1);
  cam.position.copy(here).add(new THREE.Vector3(0, 0, 2)); cam.updateMatrixWorld(true);
  tickHumanoidLod(cam);
  assert.deepEqual(h.lod.groups.map((x) => x.visible), [true, false]);
  const live = humanoidLodStats().live;
  h.release();
  assert.equal(humanoidLodStats().live, live - 1);
});
