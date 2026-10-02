// Humanoid kit — THREE glue against REAL generated GLBs (tools/humanoid-placeholder.mjs):
// rebind by bone name across rig naming schemes, shared geometry/material cache, params → bones, rigid attach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildBaseGlb, buildPieces, buildPieceGlb, kitFiles, GlbWriter, ALL_BONES, BONES, tube, Geo } from '../tools/humanoid-placeholder.mjs';
const { mountHumanoid, humanoidStats, releaseHumanoid, indexBones } = await import('../client/kernel/humanoid.js');
import { canonicalBone } from '../shared/humanoid.js';

const PREFIX = '/assets/humanoid';
const files = new Map();
files.set(`${PREFIX}/base.glb`, buildBaseGlb());
for (const p of buildPieces()) files.set(`${PREFIX}/costume/${p.file}.glb`, buildPieceGlb(p));
const U = (rel) => `${PREFIX}/${rel}`;
const BASE = U('base.glb');
const { presets } = kitFiles();

function makeLoader(extra = new Map()) {
  const calls = [];
  const real = new GLTFLoader();
  return {
    calls,
    async loadAsync(url) {
      calls.push(url);
      await new Promise((r) => setTimeout(r, 1));
      const buf = extra.get(url) ?? files.get(url);
      if (!buf) throw new Error(`404 ${url}`);
      return real.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    },
  };
}
const fetchJson = async (u) => { const name = /presets\/(\w+)\.json/.exec(u)?.[1]; if (!presets[name]) throw new Error(`404 ${u}`); return structuredClone(presets[name]); };
const deps = (loader) => ({ loader, resolveUrl: (u) => u, fetchJson });
const host = () => { const parent = new THREE.Group(), group = new THREE.Group(); parent.add(group); group.userData.humanoidToken = 1; return group; };
const mount = async (spec, loader, g = host()) => { const root = await mountHumanoid(g, spec, 1, () => {}, deps(loader)); g.updateMatrixWorld(true); return { g, root, h: root?.userData.humanoid }; };
const meshesOf = (root) => { const out = []; root.traverse((o) => o.isMesh && out.push(o)); return out; };
const skinnedOf = (root) => meshesOf(root).filter((m) => m.isSkinnedMesh);

// max |skinned position − rest geometry position| — at rest pose this must be ~0 if the rebind is right
function restError(mesh) {
  const v = new THREE.Vector3(), pos = mesh.geometry.attributes.position;
  let err = 0;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v);
    err = Math.max(err, Math.abs(v.x - pos.getX(i)), Math.abs(v.y - pos.getY(i)), Math.abs(v.z - pos.getZ(i)));
  }
  return err;
}
function bounds(mesh) {
  const v = new THREE.Vector3(), box = new THREE.Box3();
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) box.expandByPoint(mesh.getVertexPosition(i, v));
  return box;
}
function patchGlb(buf, fn) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  fn(json);
  let js = Buffer.from(JSON.stringify(json));
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const rest = buf.subarray(20 + jl);
  const out = Buffer.concat([buf.subarray(0, 12), Buffer.alloc(8), js, rest]);
  out.writeUInt32LE(out.length, 8); out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  return out;
}

const OUTFIT = { head: U('costume/head/helmet.glb'), torso: U('costume/torso/armor.glb'), legs: U('costume/legs/trousers.glb'), feet: U('costume/feet/boots.glb') };

test('generated GLBs: Mixamo base resolves to canonical rig; measured axes are right', async () => {
  const loader = makeLoader();
  const { root, h } = await mount({ base: BASE }, loader);
  assert.ok(root);
  for (const b of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftToes']) assert.ok(h.bones.has(b), b);
  assert.equal(h.axes.hips, 1);
  assert.equal(h.axes.leftUpperLeg, 1);
  assert.equal(h.axes.leftShoulder, 0); // clavicle points sideways
  assert.equal(h.axes.rightShoulder, 0);
  assert.equal(h.axes.leftFoot, 2); // foot → toes points forward
  assert.equal(skinnedOf(root).length, 2); // skin + eyes primitives
});

test('rebind BY NAME across 3 rig naming schemes: pieces ride the INSTANCE bones, rest-pose skinning is exact', async () => {
  const loader = makeLoader();
  const costume = { ...OUTFIT, hair: U('costume/hair/long.glb'), back: U('costume/back/cape.glb') }; // hair=VRoid names, cape=VRM names, rest=Mixamo
  const { g, root, h } = await mount({ base: BASE, costume }, loader);
  assert.deepEqual(h.report, { drift: [], unmapped: [], failed: [] });
  assert.deepEqual(Object.keys(h.pieces).sort(), Object.keys(costume).sort());
  const instanceNodes = new Set(); root.traverse((o) => instanceNodes.add(o));
  const templateBones = new Set(indexBones((await loader.loadAsync(BASE)).scene).values());
  let checked = 0;
  for (const [slot, piece] of Object.entries(h.pieces)) {
    assert.ok(piece.meshes.length > 0, slot);
    for (const m of piece.meshes) {
      assert.ok(m.isSkinnedMesh, `${slot} skinned`);
      for (const b of m.skeleton.bones) { assert.ok(instanceNodes.has(b), `${slot} bone ${b.name} belongs to this instance`); assert.ok(!templateBones.has(b)); }
      // piece bone names differ by scheme but every rebound bone resolves to the same canonical set as the base's
      assert.ok(m.skeleton.bones.every((b) => canonicalBone(b.name)));
      assert.ok(restError(m) < 1e-5, `${slot} rest error ${restError(m)}`);
      checked++;
    }
  }
  for (const m of skinnedOf(root).filter((m) => !Object.values(h.pieces).some((p) => p.meshes.includes(m)))) assert.ok(restError(m) < 1e-5, 'base rest error');
  assert.ok(checked >= 8, `checked ${checked}`);
  // the cape (VRM names) really follows the instance's upperChest: rotate it, vertices move
  const cape = h.pieces.back.meshes[0], before = bounds(cape).getCenter(new THREE.Vector3());
  h.bones.get('upperChest').rotation.x = 0.6; g.updateMatrixWorld(true);
  assert.ok(bounds(cape).getCenter(new THREE.Vector3()).distanceTo(before) > 0.05, 'cape follows upperChest');
});

test('params → bone scales: feet stay planted, legs/torso/arms stretch, head not distorted by build', async () => {
  const loader = makeLoader();
  const rest = await mount({ base: BASE }, loader);
  const restBox = skinnedOf(rest.root).map(bounds).reduce((a, b) => a.union(b));
  const restHead = (() => { const b = new THREE.Box3(), v = new THREE.Vector3(), m = skinnedOf(rest.root)[0]; const sk = m.geometry.attributes.skinIndex; const headIdx = m.skeleton.bones.indexOf(rest.h.bones.get('head')); for (let i = 0; i < sk.count; i++) if (sk.getX(i) === headIdx) b.expandByPoint(m.getVertexPosition(i, v)); return b.getSize(new THREE.Vector3()); })();

  const long = await mount({ base: BASE, params: { legLength: 1.25 } }, loader);
  const longBox = skinnedOf(long.root).map(bounds).reduce((a, b) => a.union(b));
  assert.ok(Math.abs(longBox.min.y - restBox.min.y) < 1e-4, `feet planted: ${longBox.min.y} vs ${restBox.min.y}`);
  const legRest = BONES.leftUpperLeg[1][1] - BONES.leftFoot[1][1]; // 0.84
  assert.ok(Math.abs(longBox.max.y - restBox.max.y - legRest * 0.25) < 1e-3, `taller by 0.25×leg: ${longBox.max.y - restBox.max.y}`);
  // foot not stretched (counter): foot box height equals rest
  const footSize = (r) => { const m = skinnedOf(r.root)[0], b = new THREE.Box3(), v = new THREE.Vector3(), idx = m.skeleton.bones.indexOf(r.h.bones.get('leftFoot')), sk = m.geometry.attributes.skinIndex; for (let i = 0; i < sk.count; i++) if (sk.getX(i) === idx) b.expandByPoint(m.getVertexPosition(i, v)); return b.getSize(new THREE.Vector3()); };
  assert.ok(footSize(long).distanceTo(footSize(rest)) < 1e-4, 'foot undistorted');

  const torso = await mount({ base: BASE, params: { torsoLength: 1.3, neckLength: 1.0 } }, loader);
  const torsoBox = skinnedOf(torso.root).map(bounds).reduce((a, b) => a.union(b));
  const torsoRest = BONES.neck[1][1] - BONES.spine[1][1];
  assert.ok(Math.abs(torsoBox.max.y - restBox.max.y - torsoRest * 0.3) < 1e-2, `torso raises head ${torsoBox.max.y - restBox.max.y}`);

  const wide = await mount({ base: BASE, params: { build: 1.4 } }, loader);
  const wideBox = skinnedOf(wide.root).map(bounds).reduce((a, b) => a.union(b));
  assert.ok(wideBox.getSize(new THREE.Vector3()).x > restBox.getSize(new THREE.Vector3()).x * 1.2, 'build widens the body');
  assert.ok(Math.abs(wideBox.max.y - restBox.max.y) < 1e-4, 'build does not change height');
  const headSize = (() => { const m = skinnedOf(wide.root)[0], b = new THREE.Box3(), v = new THREE.Vector3(), idx = m.skeleton.bones.indexOf(wide.h.bones.get('head')), sk = m.geometry.attributes.skinIndex; for (let i = 0; i < sk.count; i++) if (sk.getX(i) === idx) b.expandByPoint(m.getVertexPosition(i, v)); return b.getSize(new THREE.Vector3()); })();
  assert.ok(headSize.distanceTo(restHead) < 1e-4, `head undistorted by build: ${headSize.toArray()} vs ${restHead.toArray()}`);

  const tall = await mount({ base: BASE, params: { height: 1.3 }, scale: 1 }, loader);
  assert.ok(Math.abs(tall.root.scale.x - 1.3) < 1e-12);
  const bone = await mount({ base: BASE, bones: { head: [1.5, 1, 1] } }, loader);
  assert.ok(Math.abs(bone.h.bones.get('head').scale.x - 1.5) < 1e-12);
});

test('color slots: tint via shared (material,hex) cache; untouched slots keep the TEMPLATE material; template never mutated', async () => {
  const loader = makeLoader();
  const plain = await mount({ base: BASE, costume: OUTFIT }, loader);
  const plain2 = await mount({ base: BASE, costume: OUTFIT }, loader);
  const mats = (r) => meshesOf(r.root).map((m) => m.material);
  assert.deepEqual(mats(plain), mats(plain2)); // same objects: template materials shared, zero clones
  assert.equal(humanoidStats().materials, 0);
  const skinTemplate = meshesOf(plain.root).find((m) => m.material.name === 'skin').material;
  const skinBefore = skinTemplate.color.getHex();

  const red = await mount({ base: BASE, costume: OUTFIT, colors: { skin: '#ff0000', team: '#00ff00' } }, loader);
  const red2 = await mount({ base: BASE, costume: OUTFIT, colors: { skin: '#ff0000', team: '#00ff00' } }, loader);
  const skinMesh = (r) => meshesOf(r.root).find((m) => m.material.name.startsWith('skin'));
  assert.equal(skinMesh(red).material, skinMesh(red2).material); // SAME tinted object across instances
  assert.equal(skinMesh(red).material.color.getHexString(), 'ff0000');
  assert.equal(skinTemplate.color.getHex(), skinBefore); // template untouched
  assert.equal(skinMesh(red).material.userData.shared, true); // view.disposeOwn leaves it
  assert.notEqual(skinMesh(red).material, skinTemplate);
  const teamNames = meshesOf(red.root).map((m) => m.material.name).filter((n) => n.startsWith('team'));
  assert.ok(teamNames.length > 0 && teamNames.every((n) => n === 'team@#00ff00'), teamNames.join());
  // unslotted colors (eyes etc.) stay template
  assert.ok(meshesOf(red.root).filter((m) => m.material.name === 'eyes').every((m) => !m.material.userData.humanoidTint));
  const live = humanoidStats();
  assert.ok(live.materials >= 2 && live.refs >= live.materials * 2, JSON.stringify(live));
  red.h.release(); assert.equal(humanoidStats().materials, live.materials); // red2 still holds them
  red2.h.release(); assert.equal(humanoidStats().materials, 0); // refcount → 0 ⇒ evicted
  red2.h.release(); // idempotent
  assert.equal(humanoidStats().refs, 0);
  // `team` is colorable AFTER the fact only via a new mount — and a different hex makes a different material
  const blue = await mount({ base: BASE, costume: OUTFIT, colors: { team: '#0000ff' } }, loader);
  assert.ok(meshesOf(blue.root).some((m) => m.material.name === 'team@#0000ff'));
  blue.h.release();
});

test('RTS scale: 100 units ⇒ 1 load per GLB, 1 geometry per mesh, materials bounded by (src,hex) NOT by instances', async () => {
  const loader = makeLoader();
  const costume = { ...OUTFIT, weaponR: U('costume/weapon/sword.glb') };
  const teams = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f'];
  const units = [];
  for (let i = 0; i < 100; i++) units.push(await mount({ base: BASE, costume, colors: { team: teams[i % 4], skin: i % 2 ? '#d9a784' : '#8f5f4d' }, params: { height: 0.9 + (i % 7) * 0.03, build: 0.9 + (i % 5) * 0.05 } }, loader));
  const expectedLoads = 1 + Object.keys(costume).length;
  assert.equal(loader.calls.length, expectedLoads, `loads: ${loader.calls.length}`);
  const geoms = new Set(), mats = new Set(), skeletons = new Set();
  for (const u of units) for (const m of meshesOf(u.root)) { geoms.add(m.geometry); mats.add(m.material); if (m.isSkinnedMesh) skeletons.add(m.skeleton); }
  const perUnit = meshesOf(units[0].root).length;
  assert.equal(geoms.size, perUnit, 'one geometry per mesh slot across 100 instances');
  assert.ok(mats.size <= perUnit * 8, `materials ${mats.size} must not scale with 100 instances`); // 4 teams × 2 skins bounds it
  assert.ok(skeletons.size >= 100, 'skeletons are per instance');
  assert.equal(new Set(units.map((u) => u.h.bones.get('hips'))).size, 100);
  const stats = humanoidStats();
  assert.equal(stats.materials, [...mats].filter((m) => m.userData.humanoidTint).length);
  for (const u of units) u.h.release();
  assert.equal(humanoidStats().materials, 0);
});

test('rigid attach: sword/shield ride the instance hand bones at the authored offset and scale with the hand', async () => {
  const loader = makeLoader();
  const costume = { weaponR: U('costume/weapon/sword.glb'), weaponL: U('costume/weapon/shield.glb') };
  const tpl = (await loader.loadAsync(costume.weaponR)).scene; tpl.updateMatrixWorld(true);
  const tplSword = meshesOf(tpl)[0].getWorldPosition(new THREE.Vector3());
  const { g, h } = await mount({ base: BASE, costume }, loader);
  const sword = h.pieces.weaponR.meshes[0];
  assert.equal(sword.parent, h.bones.get('rightHand'));
  assert.equal(h.pieces.weaponL.meshes[0].parent, h.bones.get('leftHand'));
  assert.ok(!sword.isSkinnedMesh);
  assert.ok(sword.getWorldPosition(new THREE.Vector3()).distanceTo(tplSword) < 1e-5, 'authored offset kept');
  const big = await mount({ base: BASE, costume, params: { handScale: 1.5 } }, loader);
  assert.ok(big.h.pieces.weaponR.meshes[0].getWorldScale(new THREE.Vector3()).x > 1.4, 'weapon scales with the hand');
  assert.equal(g.userData.humanoidStatus, 'ready');
});

test('drift report: piece authored against a different rest pose is flagged', async () => {
  const orig = BONES.head[1][1];
  BONES.head[1][1] = orig + 0.05;
  const cap = buildPieces().find((p) => p.file === 'head/cap');
  const shifted = buildPieceGlb(cap);
  BONES.head[1][1] = orig;
  const extra = new Map([[U('costume/head/shifted.glb'), shifted]]);
  const loader = makeLoader(extra);
  const warn = console.warn; let warned = 0; console.warn = () => warned++;
  try {
    const { h } = await mount({ base: BASE, costume: { head: U('costume/head/shifted.glb') } }, loader);
    assert.ok(h.report.drift.some((d) => d.bone === 'head' && d.drift > 0.04), JSON.stringify(h.report.drift));
    assert.equal(warned, 1);
    await mount({ base: BASE, costume: { head: U('costume/head/shifted.glb') } }, loader);
    assert.equal(warned, 1, 'warns once per (base, piece)');
    const clean = await mount({ base: BASE, costume: { head: U('costume/head/cap.glb') } }, loader);
    assert.deepEqual(clean.h.report.drift, []);
  } finally { console.warn = warn; }
});

test('unmapped / folded bones: missing base bone folds to nearest mapped ancestor; fully foreign skeleton rides the hips; rest pose stays exact', async () => {
  // (a) base WITHOUT toes, piece weighted to toes → folds onto the foot
  const w = new GlbWriter();
  const noToes = ALL_BONES.filter((b) => !b.endsWith('Toes'));
  w.skeleton(noToes, 'mixamo');
  const g = new Geo(); tube(g, 'leftFoot', [0.09, 0.04, -0.05], [0.09, 0.04, 0.17], [0.04, 0.04], [0.035, 0.026]);
  w.skinnedMesh('Stub', { skin: g });
  const baseNoToes = w.build();
  const p = new GlbWriter();
  p.skeleton(ALL_BONES, 'mixamo');
  const tg = new Geo(); tube(tg, 'leftToes', [0.09, 0.02, 0.1], [0.09, 0.02, 0.2], [0.03, 0.02], [0.03, 0.02]);
  p.skinnedMesh('toecap', { accent: tg });
  const toecap = p.build();
  const extra = new Map([[U('nt-base.glb'), baseNoToes], [U('costume/feet/toecap.glb'), toecap]]);
  const loader = makeLoader(extra);
  const a = await mount({ base: U('nt-base.glb'), costume: { feet: U('costume/feet/toecap.glb') } }, loader);
  assert.ok(!a.h.bones.has('leftToes'));
  const m = a.h.pieces.feet.meshes[0];
  assert.ok(m.skeleton.bones.includes(a.h.bones.get('leftFoot')), 'toes folded onto foot');
  assert.ok(restError(m) < 1e-5, `folded rest error ${restError(m)}`);
  a.h.bones.get('leftFoot').rotation.x = 0.5; a.g.updateMatrixWorld(true);
  assert.ok(restError(m) > 0.01, 'folded verts follow the foot');
  assert.deepEqual(a.h.report.unmapped, []);

  // (b) piece with a totally foreign skeleton (no canonical names at all) → rides hips, reported
  const alien = patchGlb(files.get(U('costume/hair/short.glb')), (j) => j.nodes.forEach((n, i) => { n.name = `Wig_${i}`; }));
  const loader2 = makeLoader(new Map([[U('costume/hair/alien.glb'), alien]]));
  const b = await mount({ base: BASE, costume: { hair: U('costume/hair/alien.glb') } }, loader2);
  assert.equal(b.h.report.unmapped.length, 6);
  assert.ok(restError(b.h.pieces.hair.meshes[0]) < 1e-5);
  assert.ok(b.h.pieces.hair.meshes[0].skeleton.bones.every((x) => x === b.h.bones.get('hips')));
});

test('presets + seed through the real mount: extends chain, deterministic per seed, variants differ', async () => {
  const loader = makeLoader();
  const keyOf = async (spec) => (await mount(spec, loader)).h.concrete.key;
  const a1 = await keyOf({ preset: U('presets/soldier.json'), seed: 11 });
  const a2 = await keyOf({ preset: U('presets/soldier.json'), seed: 11 });
  const b = await keyOf({ preset: U('presets/soldier.json'), seed: 12 });
  const plain = await mount({ preset: U('presets/soldier.json') }, loader);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(plain.h.concrete.base, BASE); // inherited through `extends: mannequin`
  assert.equal(Object.keys(plain.h.pieces).length, 6);
  // explicit unit override beats preset + seed
  const o = await mount({ preset: U('presets/soldier.json'), seed: 11, costume: { head: null }, colors: { team: '#123456' } }, loader);
  assert.equal(o.h.concrete.costume.head, null);
  assert.equal(o.h.pieces.head, undefined);
  assert.equal(o.h.concrete.colors.team, '#123456');
});

test('failure modes: bad piece ⇒ unit still mounts + reported; no base / 404 base ⇒ error status, null, no throw; stale token ⇒ dropped + released', async () => {
  const loader = makeLoader();
  const ok = await mount({ base: BASE, costume: { torso: U('costume/torso/NOPE.glb'), head: U('costume/head/cap.glb') } }, loader);
  assert.ok(ok.root);
  assert.equal(ok.h.report.failed.length, 1);
  assert.equal(ok.h.report.failed[0].slot, 'torso');
  assert.ok(ok.h.pieces.head && !ok.h.pieces.torso);

  const err = console.error; console.error = () => {};
  try {
    const g1 = host();
    assert.equal(await mountHumanoid(g1, {}, 1, () => {}, deps(loader)), null);
    assert.equal(g1.userData.humanoidStatus, 'error');
    const g2 = host();
    assert.equal(await mountHumanoid(g2, { base: U('nope.glb') }, 1, () => {}, deps(loader)), null);
    assert.equal(g2.userData.humanoidStatus, 'error');
    // retry after a failed load works (cache entry evicted)
    assert.equal(loader.calls.filter((c) => c === U('nope.glb')).length, 1);
    await mountHumanoid(host(), { base: U('nope.glb') }, 1, () => {}, deps(loader));
    assert.equal(loader.calls.filter((c) => c === U('nope.glb')).length, 2);
  } finally { console.error = err; }

  const before = humanoidStats().materials;
  const g = host();
  const pending = mountHumanoid(g, { base: BASE, colors: { skin: '#abcdef' } }, 1, () => {}, deps(loader));
  g.userData.humanoidToken = 2; // newer applyMesh superseded this one
  assert.equal(await pending, null);
  assert.equal(g.children.length, 0);
  assert.equal(humanoidStats().materials, before, 'dropped instance released its tinted materials');
});

test('releaseHumanoid (view.disposeObject hook) frees skeleton textures once, never geometry', async () => {
  const loader = makeLoader();
  const baseline = humanoidStats().materials; // other tests may leave tinted materials alive
  const { root, h } = await mount({ base: BASE, colors: { skin: '#123123' }, costume: OUTFIT }, loader);
  let geoDisposed = 0;
  for (const m of meshesOf(root)) m.geometry.addEventListener('dispose', () => geoDisposed++);
  assert.ok(humanoidStats().materials > baseline);
  let matDisposed = 0;
  for (const m of meshesOf(root)) if (m.material.userData.humanoidTint) m.material.addEventListener('dispose', () => matDisposed++);
  releaseHumanoid(root); releaseHumanoid(root);
  assert.equal(humanoidStats().materials, baseline);
  assert.ok(matDisposed >= 1, 'tinted material disposed at refcount 0');
  assert.equal(geoDisposed, 0);
  assert.ok(meshesOf(root).every((m) => m.geometry.userData.shared === true));
  h.release();
});
