// Humanoid kit stage 6 — clip playback: resolve, shared AnimationClip objects, crossfade state, missing clip ⇒ warn + keep, restyle patch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildBaseGlb, buildPieces, buildPieceGlb } from '../tools/humanoid-placeholder.mjs';
import { normalizeClip, resolveClipName, retargetTrackName, resolveHumanoid, validateHumanoid, CLIP_FADE } from '../shared/humanoid.js';
const { mountHumanoid, patchHumanoidClip, humanoidSig, indexBones } = await import('../client/kernel/humanoid.js');
const { tickHumanoidClips, humanoidClipStats } = await import('../client/kernel/humanoid-clip.js');

const PREFIX = '/assets/humanoid';
const U = (rel) => `${PREFIX}/${rel}`;
const BASE = U('base.glb');
const files = new Map([[BASE, buildBaseGlb()], [U('base_lod1.glb'), buildBaseGlb()]]);
for (const p of buildPieces()) files.set(`${PREFIX}/costume/${p.file}.glb`, buildPieceGlb(p));
const OUTFIT = { torso: U('costume/torso/armor.glb'), legs: U('costume/legs/trousers.glb') };

// real parse once to learn the base's bone names, so the synthetic clips address real nodes
const realParse = (buf) => new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const probe = indexBones((await realParse(files.get(BASE))).scene);
const HIPS = probe.get('hips').name;
const SPINE = probe.get('spine').name;
const Q = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), THREE.MathUtils.degToRad(deg));
const qTrack = (node, q0, q1) => new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, [0, 1], [...q0.toArray(), ...q1.toArray()]);
const baseClips = () => [
  new THREE.AnimationClip('walk', 1, [qTrack(HIPS, Q([0, 1, 0], 0), Q([0, 1, 0], 90)), new THREE.VectorKeyframeTrack(`${SPINE}.scale`, [0, 1], [1, 1, 1, 2, 2, 2])]),
  new THREE.AnimationClip('Armature|Idle', 1, [qTrack(SPINE, Q([1, 0, 0], 0), Q([1, 0, 0], 30))]),
  new THREE.AnimationClip('wave', 1, [qTrack(SPINE, Q([0, 0, 1], 0), Q([0, 0, 1], 60))]),
];
// foreign-rig clip glb (node names the base does NOT have) — retargeted by canonical bone
const FOREIGN_HIPS = ['Hips', 'mixamorigHips', 'J_Bip_C_Hips'].find((n) => n !== HIPS);

function makeLoader() {
  const loads = new Map();
  return {
    loads,
    async loadAsync(url) {
      loads.set(url, (loads.get(url) ?? 0) + 1);
      if (url === U('clips.glb')) return { scene: new THREE.Group(), animations: [new THREE.AnimationClip('run', 1, [qTrack(FOREIGN_HIPS, Q([0, 1, 0], 0), Q([0, 1, 0], 180)), qTrack('Nonexistent_Bone', Q([0, 1, 0], 0), Q([0, 1, 0], 1))]), new THREE.AnimationClip('wave', 2, [qTrack(FOREIGN_HIPS, Q([0, 0, 1], 0), Q([0, 0, 1], 5))])] };
      const buf = files.get(url);
      if (!buf) throw new Error(`404 ${url}`);
      const r = await realParse(buf);
      if (url === BASE) r.animations = baseClips();
      return r;
    },
  };
}
const deps = (loader) => ({ loader, resolveUrl: (u) => u, fetchJson: async () => ({}) });
const mount = async (spec, loader = makeLoader()) => {
  const parent = new THREE.Group(), g = new THREE.Group(); parent.add(g); g.userData.humanoidToken = 1;
  const root = await mountHumanoid(g, spec, 1, () => {}, deps(loader)); g.updateMatrixWorld(true);
  return { g, root, h: root?.userData.humanoid, loader };
};
const withWarn = async (fn) => {
  const real = console.warn, got = [];
  console.warn = (...a) => got.push(a.join(' '));
  try { return [await fn(), got]; } finally { console.warn = real; }
};
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

test('pure: normalizeClip / resolveClipName / retargetTrackName / resolve render.clip (not unit identity)', () => {
  assert.deepEqual(normalizeClip('walk'), { name: 'walk', speed: 1, loop: true, t0: 0 });
  assert.deepEqual(normalizeClip({ name: 'a', speed: 2, loop: false, t0: 0.5 }), { name: 'a', speed: 2, loop: false, t0: 0.5 });
  assert.deepEqual(normalizeClip({ name: 'a', speed: 'x', t0: -3 }), { name: 'a', speed: 1, loop: true, t0: 0 });
  for (const bad of [null, undefined, '', {}, { name: 5 }, 7, []]) assert.equal(normalizeClip(bad), null);
  const names = ['Armature|Walk', 'Run', 'run2'];
  assert.equal(resolveClipName(names, 'Run'), 'Run');
  assert.equal(resolveClipName(names, 'Walk'), 'Armature|Walk', 'tail after |');
  assert.equal(resolveClipName(names, 'walk'), 'Armature|Walk', 'case-insensitive');
  assert.equal(resolveClipName(names, 'nope'), null);
  const rig = { has: (n) => n === 'Hips', nameOfCanon: (c) => (c === 'spine' ? 'Spine' : null) };
  assert.equal(retargetTrackName('Hips.position', rig), 'Hips.position', 'exact node kept');
  assert.equal(retargetTrackName('mixamorigSpine.quaternion', rig), 'Spine.quaternion', 'canonical remap');
  assert.equal(retargetTrackName('Zork.quaternion', rig), null, 'unmappable dropped');
  const a = resolveHumanoid({ base: 'b', clip: { name: 'walk', speed: 2 }, clips: 'x.glb' });
  assert.deepEqual(a.render.clip, { name: 'walk', speed: 2, loop: true, t0: 0 });
  assert.equal(a.render.clips, 'x.glb');
  assert.equal(a.key, resolveHumanoid({ base: 'b' }).key, 'clip/clips are render state, not unit identity');
  assert.equal(resolveHumanoid({ base: 'b' }).render.clip, null);
  assert.deepEqual(validateHumanoid({ base: 'b', clip: 7 }), ['clip must be a name string or { name, speed?, loop?, t0? }']);
  assert.deepEqual(validateHumanoid({ base: 'b', clip: { name: 'x' }, clips: 'u' }), []);
  assert.equal(CLIP_FADE, 0.15);
});

test('clip resolve: world data plays at mount (pose applied before first frame); scale tracks stripped; names resolve loosely', async () => {
  const { root, h } = await mount({ base: BASE, costume: OUTFIT, clip: { name: 'walk', speed: 1, t0: 0.5 } });
  assert.equal(h.clipInfo.applied, 'walk');
  assert.deepEqual(h.clipNames().sort(), ['Armature|Idle', 'walk', 'wave']);
  assert.equal(h.clipState().name, 'walk');
  assert.ok(near(h.clipState().time, 0.5), 'starts at t0');
  const hips = h.bones.get('hips');
  assert.ok(near(hips.quaternion.angleTo(new THREE.Quaternion()), THREE.MathUtils.degToRad(45), 0.02), `hips at t0=.5 of 0→90° = 45°, got ${hips.quaternion.angleTo(new THREE.Quaternion())}`);
  assert.ok(!h.getClip('walk').tracks.some((t) => t.name.endsWith('.scale')), 'scale tracks stripped (params own bone scale)');
  assert.equal(h.getClip('idle'), h.getClip('Armature|Idle'), 'case/tail-insensitive resolve');
  assert.ok(root.userData.humanoid.setClip && root.userData.humanoid.clipState);
});

test('shared: AnimationClip objects parsed once per base template, one mixer per instance, base loaded once', async () => {
  const loader = makeLoader();
  const a = await mount({ base: BASE, clip: 'walk' }, loader);
  const b = await mount({ base: BASE, clip: 'walk', costume: OUTFIT }, loader);
  assert.equal(loader.loads.get(BASE), 1, 'base glb (and its clips) loaded once');
  assert.equal(a.h.getClip('walk'), b.h.getClip('walk'), 'SAME AnimationClip object');
  assert.equal(a.h.getClip('wave'), b.h.getClip('wave'));
  // independent phase per instance (own mixer)
  tickHumanoidClips(0.25);
  a.h.setClip('walk', { t0: 0.5 }); // same clip ⇒ in place, no restart
  assert.ok(near(a.h.clipState().time, 0.25) && near(b.h.clipState().time, 0.25));
  const c = await mount({ base: BASE, clip: { name: 'walk', t0: 0.75 } }, loader);
  assert.ok(near(c.h.clipState().time, 0.75) && near(a.h.clipState().time, 0.25), 'per-instance mixer state');
  assert.equal(c.h.getClip('walk'), a.h.getClip('walk'));
});

test('mixer drives the shared instance bones: every LOD level skins from the same pose (LOD switch keeps pose)', async () => {
  const { root, h } = await mount({ base: BASE, costume: OUTFIT, clip: { name: 'walk', t0: 1 }, lod: { bases: [U('base_lod1.glb')], distances: [20] } });
  const levels = h.lod.groups;
  assert.equal(levels.length, 2);
  const inst = new Set(h.bones.values());
  for (const grp of levels) grp.traverse((o) => { if (o.isSkinnedMesh) assert.ok(o.skeleton.bones.every((bn) => inst.has(bn) || bn.parent), 'joints are instance nodes'); });
  // bone driven by the mixer is the SAME object in both levels' skeletons
  const hips = h.bones.get('hips');
  for (const grp of levels) { let used = false; grp.traverse((o) => { if (o.isSkinnedMesh && o.skeleton.bones.includes(hips)) used = true; }); assert.ok(used, 'level skeleton references the driven hips'); }
  const turned = Math.abs(hips.quaternion.angleTo(new THREE.Quaternion()) - Math.PI / 2) < 0.02;
  assert.ok(turned, 'pose applied (hips 90° at t=1)');
  // skinned vertices actually moved off bind pose in the visible level; switching level keeps the same bones/pose
  root.updateMatrixWorld(true);
  const m0 = levels[0].children.find((o) => o.isSkinnedMesh);
  const v = new THREE.Vector3(), pos = m0.geometry.attributes.position;
  let moved = 0;
  for (let i = 0; i < pos.count; i++) { m0.getVertexPosition(i, v); moved = Math.max(moved, Math.abs(v.x - pos.getX(i)) + Math.abs(v.z - pos.getZ(i))); }
  assert.ok(moved > 0.01, `skinned vertices follow the clip (moved ${moved})`);
});

test('clip change crossfades 0.15s: state machine fading → done; same clip = in-place speed/loop, no fade; null stops', async () => {
  const { h } = await mount({ base: BASE, clip: 'walk' });
  assert.equal(h.clipState().fading, false, 'first clip: no fade');
  assert.equal(h.setClip('wave'), true);
  let s = h.clipState();
  assert.deepEqual([s.name, s.fading, s.from, s.fadeDur], ['wave', true, 'walk', CLIP_FADE]);
  tickHumanoidClips(0.075);
  s = h.clipState();
  assert.ok(s.fading && near(s.fadeT, 0.075) && near(s.weight, 0.5, 0.05), `half-way: weight ${s.weight}`);
  tickHumanoidClips(0.1);
  s = h.clipState();
  assert.ok(!s.fading && near(s.weight, 1), 'fade complete');
  // same clip: speed/loop in place
  h.setClip('wave', { speed: 2, loop: false });
  s = h.clipState();
  assert.deepEqual([s.name, s.speed, s.loop, s.fading], ['wave', 2, false, false]);
  const t = h.clipState().time;
  tickHumanoidClips(0.25);
  assert.ok(near(h.clipState().time - t, 0.5), 'speed 2 ⇒ 0.5 clip-s per 0.25 s');
  tickHumanoidClips(1);
  assert.ok(h.clipState().finished, 'loop:false finishes + clamps');
  assert.ok(near(h.bones.get('spine').quaternion.angleTo(new THREE.Quaternion()), THREE.MathUtils.degToRad(60), 0.02), 'clamped at last pose');
  // explicit fade 0 ⇒ hard cut; null stops (fades out)
  h.setClip('walk', { fade: 0 });
  assert.equal(h.clipState().fading, false);
  h.setClip(null);
  assert.deepEqual([h.clipState().name, h.clipState().fading], [null, true]);
  tickHumanoidClips(0.2);
  assert.equal(h.clipState().fading, false);
});

test('missing clip ⇒ warn ONCE + keep previous (setClip returns false); missing at mount ⇒ no throw, rest pose, reported', async () => {
  const { h } = await mount({ base: BASE, clip: 'walk' });
  const before = h.clipState();
  const [r, warns] = await withWarn(() => [h.setClip('moonwalk'), h.setClip('moonwalk')]);
  assert.deepEqual(r, [false, false]);
  assert.equal(warns.length, 1, 'warned once per name');
  assert.match(warns[0], /clip "moonwalk" not found.*keeping "walk"/);
  const after = h.clipState();
  assert.deepEqual([after.name, after.fading, after.speed], [before.name, before.fading, before.speed], 'previous clip untouched');
  const [m, w2] = await withWarn(() => mount({ base: BASE, clip: 'nope' }));
  assert.ok(m.root, 'unit still mounts');
  assert.equal(m.h.clipInfo.applied, null);
  assert.equal(m.h.clipState().name, null);
  assert.equal(w2.filter((x) => /clip "nope" not found/.test(x)).length, 1);
  assert.equal(m.h.bones.get('hips').quaternion.angleTo(new THREE.Quaternion()), 0, 'rest pose kept');
});

test('clips: <url> — foreign-rig clips retargeted by canonical bone, shared per (clips url, base), override same-named base clips; bad url keeps base clips', async () => {
  const loader = makeLoader();
  const a = await mount({ base: BASE, clips: U('clips.glb'), clip: 'run' }, loader);
  const b = await mount({ base: BASE, clips: U('clips.glb'), clip: 'run' }, loader);
  assert.equal(loader.loads.get(U('clips.glb')), 1, 'clips glb parsed once');
  assert.ok(a.h.clipNames().includes('run') && a.h.clipNames().includes('walk'), 'url clips + base clips');
  assert.equal(a.h.getClip('run'), b.h.getClip('run'), 'retargeted clip object shared');
  assert.deepEqual(a.h.getClip('run').tracks.map((t) => t.name), [`${HIPS}.quaternion`], 'renamed onto base hips; unmappable track dropped');
  assert.equal(a.h.getClip('wave').duration, 2, 'url clip overrides base clip of the same name');
  assert.equal(a.h.clipState().name, 'run');
  tickHumanoidClips(0.5);
  assert.ok(near(a.h.bones.get('hips').quaternion.angleTo(new THREE.Quaternion()), Math.PI / 2, 0.02), 'retargeted clip drives the base hips (90° at t=.5 of 0→180°)');
  const [bad] = await withWarn(() => mount({ base: BASE, clips: U('missing.glb'), clip: 'walk' }, loader));
  assert.ok(bad.root && bad.h.clipState().name === 'walk', 'bad clips url ⇒ base clips still play');
  assert.equal(bad.h.report.failed.find((f) => f.slot === 'clips')?.url, U('missing.glb'));
});

test('per-piece path (merge:false) plays the same clips on the same bones', async () => {
  const { h } = await mount({ base: BASE, merge: false, costume: OUTFIT, clip: { name: 'walk', t0: 1 } });
  assert.equal(h.clipState().name, 'walk');
  assert.ok(near(h.bones.get('hips').quaternion.angleTo(new THREE.Quaternion()), Math.PI / 2, 0.02));
});

test('restyle: ONLY humanoid.clip changed ⇒ patch in place (crossfade); body/other change ⇒ remount signal; release frees the live tick', async () => {
  const spec = { base: BASE, costume: OUTFIT, clip: 'walk' };
  const recipe = { humanoid: spec };
  const { g, h } = await mount(spec);
  g.userData.humanoidSig = humanoidSig(recipe);
  assert.equal(patchHumanoidClip(g, { humanoid: { ...spec, clip: { name: 'wave', speed: 2 } } }), true);
  const s = h.clipState();
  assert.deepEqual([s.name, s.speed, s.fading, s.from], ['wave', 2, true, 'walk']);
  assert.equal(patchHumanoidClip(g, { humanoid: { ...spec, clip: null } }), true, 'clip:null stops');
  assert.equal(h.clipState().name, null);
  assert.equal(patchHumanoidClip(g, { humanoid: { ...spec, params: { height: 1.2 }, clip: 'wave' } }), false, 'body changed ⇒ caller remounts');
  assert.equal(patchHumanoidClip(g, { humanoid: { ...spec, clip: 'wave' }, parts: [] }), false, 'other recipe keys changed ⇒ remount');
  tickHumanoidClips(0.3); // fade-out done ⇒ idle player leaves the tick set
  const live0 = humanoidClipStats().live;
  h.setClip('walk');
  assert.equal(humanoidClipStats().live, live0 + 1, 'active player registered in the tick set');
  h.release();
  assert.equal(humanoidClipStats().live, live0, 'release unregisters + disposes the mixer');
  h.release(); // idempotent
});
