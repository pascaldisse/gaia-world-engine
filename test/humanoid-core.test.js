// Humanoid kit — pure data core: bone aliases, merge/extends, seeded resolve, param solve, color slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_BONES, canonicalBone, indexBoneNames, measureLengthAxis, NEXT_BONE,
  PARAM_DEFS, PARAM_RULES, solveBoneScales, hash32, draw, mergeSpec, loadPresetChain,
  normalizeHex, validateHumanoid, resolveHumanoid, slotOfMaterial,
} from '../shared/humanoid.js';

test('canonicalBone: VRM, Mixamo (with/without colon, numbered prefix), VRoid all hit one set', () => {
  const table = [
    ['hips', 'hips'], ['mixamorig:Hips', 'hips'], ['mixamorigHips', 'hips'], ['J_Bip_C_Hips', 'hips'],
    ['mixamorig:Spine1', 'chest'], ['mixamorig:Spine2', 'upperChest'], ['J_Bip_C_UpperChest', 'upperChest'],
    ['mixamorig:LeftArm', 'leftUpperArm'], ['mixamorig1:RightForeArm', 'rightLowerArm'], ['J_Bip_L_UpperArm', 'leftUpperArm'],
    ['mixamorig:LeftUpLeg', 'leftUpperLeg'], ['mixamorigRightLeg', 'rightLowerLeg'], ['J_Bip_R_LowerLeg', 'rightLowerLeg'],
    ['mixamorig:LeftToeBase', 'leftToes'], ['J_Bip_L_ToeBase', 'leftToes'], ['leftToes', 'leftToes'],
    ['mixamorig:LeftHandThumb1', 'leftThumbMetacarpal'], ['mixamorig:RightHandIndex3', 'rightIndexDistal'], ['J_Bip_L_Little2', 'leftLittleIntermediate'],
    ['mixamorig:LeftShoulder', 'leftShoulder'], ['Head', 'head'], ['neck', 'neck'],
  ];
  for (const [name, want] of table) assert.equal(canonicalBone(name), want, name);
  for (const junk of ['Cape_01', 'Armature', 'sword_tip', '', null, undefined]) assert.equal(canonicalBone(junk), null, String(junk));
  // every canonical bone resolves to itself
  for (const b of CANONICAL_BONES) assert.equal(canonicalBone(b), b);
  assert.equal(new Set(CANONICAL_BONES).size, CANONICAL_BONES.length);
});

test('indexBoneNames: first wins, junk dropped', () => {
  const idx = indexBoneNames(['Armature', 'mixamorig:Hips', 'mixamorig:Spine', 'hips', 'cape']);
  assert.deepEqual(idx, { hips: 'mixamorig:Hips', spine: 'mixamorig:Spine' });
});

test('measureLengthAxis picks dominant axis; zero vector falls back to Y; NEXT_BONE chains are canonical', () => {
  assert.equal(measureLengthAxis([0.01, -0.4, 0.02]), 1);
  assert.equal(measureLengthAxis([-0.15, 0, 0]), 0);
  assert.equal(measureLengthAxis([0, 0.01, 0.1]), 2);
  assert.equal(measureLengthAxis([0, 0, 0]), 1);
  for (const [bone, nexts] of Object.entries(NEXT_BONE)) {
    assert.ok(CANONICAL_BONES.includes(bone), bone);
    for (const n of nexts) assert.ok(CANONICAL_BONES.includes(n), n);
  }
});

test('mergeSpec: deep objects, scalars/arrays replace, null clears, vary replaced whole, no input mutation', () => {
  const a = { base: 'a.glb', params: { height: 1, build: 1 }, costume: { head: 'h.glb', torso: 't.glb' }, vary: { params: { height: 0.1 }, palettes: { skin: ['#fff'] } }, position: [1, 2, 3] };
  const frozen = JSON.stringify(a);
  const m = mergeSpec(a, { params: { height: 1.2 }, costume: { head: null }, vary: { params: { build: 0.2 } }, position: [9, 9, 9] });
  assert.deepEqual(m.params, { height: 1.2, build: 1 });
  assert.deepEqual(m.costume, { head: null, torso: 't.glb' });
  assert.deepEqual(m.vary, { params: { build: 0.2 } }); // replaced, palettes gone
  assert.deepEqual(m.position, [9, 9, 9]);
  assert.equal(JSON.stringify(a), frozen);
});

test('loadPresetChain: extends parent→child, cycle + depth guarded', async () => {
  const files = {
    'human.json': { name: 'human', base: 'b.glb', params: { height: 1, build: 1 }, colors: { skin: '#aaa' } },
    'soldier.json': { extends: 'human.json', params: { build: 1.1 }, costume: { torso: 'armor.glb' } },
    'captain.json': { extends: 'soldier.json', colors: { team: '#f00' } },
    'loopA.json': { extends: 'loopB.json' }, 'loopB.json': { extends: 'loopA.json' },
    'd0.json': { extends: 'd1.json' }, 'd1.json': { extends: 'd2.json' }, 'd2.json': { extends: 'd3.json' }, 'd3.json': { extends: 'd4.json' }, 'd4.json': { extends: 'd5.json' }, 'd5.json': {},
  };
  const fetchJson = async (u) => { if (!(u in files)) throw new Error(`404 ${u}`); return files[u]; };
  const p = await loadPresetChain('captain.json', fetchJson);
  assert.equal(p.base, 'b.glb');
  assert.deepEqual(p.params, { height: 1, build: 1.1 });
  assert.deepEqual(p.colors, { skin: '#aaa', team: '#f00' });
  assert.deepEqual(p.costume, { torso: 'armor.glb' });
  assert.ok(!('extends' in p));
  await assert.rejects(loadPresetChain('loopA.json', fetchJson), /cycle/);
  await assert.rejects(loadPresetChain('d0.json', fetchJson), /deeper than/);
  await assert.rejects(loadPresetChain('nope.json', fetchJson), /404/);
});

test('normalizeHex', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('2A4D8F'), '#2a4d8f');
  for (const bad of ['#12', 'red', '#gggggg', 5, null, undefined]) assert.equal(normalizeHex(bad), null);
});

test('resolve: defaults fill every param; clamp; bad colors dropped; costume null kept; base null w/o base', () => {
  const c = resolveHumanoid({ base: 'x.glb', params: { height: 99, build: -3, bogus: 2 }, colors: { skin: '#ABC', team: 'nope' }, costume: { head: 'h.glb', legs: null, feet: 7 } });
  assert.deepEqual(Object.keys(c.params), Object.keys(PARAM_DEFS));
  assert.equal(c.params.height, PARAM_DEFS.height.range[1]);
  assert.equal(c.params.build, PARAM_DEFS.build.range[0]);
  assert.equal(c.params.legLength, 1);
  assert.ok(!('bogus' in c.params));
  assert.deepEqual(c.colors, { skin: '#aabbcc' });
  assert.deepEqual(c.costume, { head: 'h.glb', legs: null, feet: null });
  assert.equal(resolveHumanoid({}).base, null);
  assert.match(c.key, /^[0-9a-f]{8}$/);
});

test('resolve: no seed ⇒ vary ignored (neutral preset); same data ⇒ same key; different data ⇒ different key', () => {
  const preset = { base: 'b.glb', vary: { params: { height: 0.1 }, palettes: { hair: ['#111111', '#eeeeee'] } } };
  const a = resolveHumanoid({}, preset);
  assert.equal(a.params.height, 1);
  assert.ok(!('hair' in a.colors));
  assert.equal(resolveHumanoid({}, preset).key, a.key);
  assert.notEqual(resolveHumanoid({ params: { height: 1.1 } }, preset).key, a.key);
});

test('resolve: seed is deterministic; precedence explicit > seed > preset; per-key streams are order independent', () => {
  const preset = {
    base: 'b.glb', params: { height: 1, build: 1 }, colors: { skin: '#808080' },
    vary: { params: { height: 0.2, build: 0.2 }, palettes: { skin: ['#111111', '#222222', '#333333', '#444444'], hair: ['#aa0000', '#00aa00'] }, costume: { head: [null, 'a.glb', 'b.glb'] } },
  };
  const r1 = resolveHumanoid({ seed: 42 }, preset);
  const r2 = resolveHumanoid({ seed: 42 }, preset);
  assert.deepEqual(r1, r2);
  assert.notEqual(resolveHumanoid({ seed: 43 }, preset).key, r1.key);
  assert.ok(Math.abs(r1.params.height - 1) <= 0.2 + 1e-9 && r1.params.height !== 1);
  assert.ok(['#111111', '#222222', '#333333', '#444444'].includes(r1.colors.skin));
  // explicit unit values beat the seed
  const e = resolveHumanoid({ seed: 42, params: { height: 1.5 }, colors: { skin: '#abcdef' }, costume: { head: null } }, preset);
  assert.equal(e.params.height, 1.5);
  assert.equal(e.colors.skin, '#abcdef');
  assert.equal(e.costume.head, null);
  assert.equal(e.params.build, r1.params.build); // other keys keep their stream
  assert.equal(e.colors.hair, r1.colors.hair);
  // reordering/removing vary keys must not reshuffle the survivors
  const preset2 = { ...preset, vary: { costume: preset.vary.costume, palettes: { hair: preset.vary.palettes.hair }, params: { build: 0.2 } } };
  const r3 = resolveHumanoid({ seed: 42 }, preset2);
  assert.equal(r3.params.build, r1.params.build);
  assert.equal(r3.colors.hair, r1.colors.hair);
  assert.equal(r3.costume.head, r1.costume.head);
  // string seeds work, and spread across a population (not all one pick)
  const picks = new Set(Array.from({ length: 64 }, (_, i) => resolveHumanoid({ seed: `unit-${i}` }, preset).colors.skin));
  assert.ok(picks.size >= 3, `palette spread ${picks.size}`);
  // numeric draw uniformity sanity
  const mean = Array.from({ length: 2000 }, (_, i) => draw(i, 'x')).reduce((s, v) => s + v, 0) / 2000;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
  assert.equal(hash32('abc'), hash32('abc'));
});

test('resolve: seeded params clamp to range after jitter', () => {
  const c = resolveHumanoid({ seed: 1 }, { base: 'b', params: { headScale: 1.5 }, vary: { params: { headScale: 5 } } });
  assert.ok(c.params.headScale <= PARAM_DEFS.headScale.range[1] && c.params.headScale >= PARAM_DEFS.headScale.range[0]);
});

test('solveBoneScales: neutral = nothing; modes follow measured axes; counters invert on the rule axis; absent bones skipped; bones override last', () => {
  const neutral = resolveHumanoid({ base: 'b' });
  assert.deepEqual(solveBoneScales(neutral), { root: 1, bones: {} });

  const axes = { hips: 1, leftUpperLeg: 1, rightUpperLeg: 1, leftShoulder: 0, rightShoulder: 0, leftUpperArm: 2 };
  const c = resolveHumanoid({ base: 'b', params: { height: 1.2, build: 1.25, legLength: 1.25, shoulders: 1.25, headScale: 1.4, armLength: 1.25 }, bones: { head: 1.1, leftHand: [2, 1, 1] } });
  const s = solveBoneScales(c, { axes });
  const near = (got, want, msg) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-12, `${msg} ${got} vs ${want}`));
  assert.equal(s.root, 1.2);
  assert.deepEqual(s.bones.hips, [1.25, 1, 1.25]); // width = non-length axes (y is length)
  assert.deepEqual(s.bones.leftUpperLeg, [1, 1.25, 1]); // ONE bone carries the stretch
  assert.ok(!('leftLowerLeg' in s.bones)); // inherits — no compounding
  near(s.bones.leftFoot, [1, 1 / 1.25, 1], 'foot counter'); // inverse on the rule bone's axis
  assert.deepEqual(s.bones.leftShoulder, [1.25, 1, 1]); // shoulder length axis = x
  // leftUpperArm: shoulders counter (x axis) × armLength (measured z axis) → [0.8, 1, 1.25]
  near(s.bones.leftUpperArm, [1 / 1.25, 1, 1.25], 'upperArm');
  near(s.bones.head, [(1 / 1.25) * 1.4 * 1.1, 1.4 * 1.1, (1 / 1.25) * 1.4 * 1.1], 'head: build counter × headScale × override');
  // leftHand: armLength counter on the upper arm's z axis × explicit override [2,1,1] → [2, 1, 0.8]
  near(s.bones.leftHand, [2, 1, 1 / 1.25], 'hand');

  const only = solveBoneScales(c, { axes, has: new Set(['hips', 'head']) });
  assert.deepEqual(Object.keys(only.bones).sort(), ['head', 'hips']);
  const fn = solveBoneScales(c, { axes, has: (b) => b === 'hips' });
  assert.deepEqual(Object.keys(fn.bones), ['hips']);
  // missing rule bone ⇒ its counters are skipped too
  const noLeg = solveBoneScales(c, { axes, has: (b) => b !== 'leftUpperLeg' });
  assert.ok(!('leftUpperLeg' in noLeg.bones) && !('leftFoot' in noLeg.bones) && 'rightFoot' in noLeg.bones);
  // axis fallback (no measured axes): shoulders along x, everything else y
  const d = solveBoneScales(resolveHumanoid({ base: 'b', params: { shoulders: 1.2, legLength: 1.2 } }));
  assert.deepEqual(d.bones.leftShoulder, [1.2, 1, 1]);
  assert.deepEqual(d.bones.leftUpperLeg, [1, 1.2, 1]);
  // every rule names canonical bones + a known mode
  for (const rules of Object.values(PARAM_RULES)) for (const r of rules) {
    if (r.root) continue;
    assert.ok(['uniform', 'length', 'width'].includes(r.mode));
    for (const b of [r.bone, ...(r.counter ?? [])]) assert.ok(CANONICAL_BONES.includes(b), b);
  }
});

test('slotOfMaterial: exact, suffixed, longest wins, tag wins, unknown null', () => {
  assert.equal(slotOfMaterial('skin'), 'skin');
  assert.equal(slotOfMaterial('Skin.001'), 'skin');
  assert.equal(slotOfMaterial('primary_trim'), 'primary');
  assert.equal(slotOfMaterial('team:cape'), 'team');
  assert.equal(slotOfMaterial('skinny'), null); // not a boundary
  assert.equal(slotOfMaterial('Material.012'), null);
  assert.equal(slotOfMaterial('x', ['a', 'a_b'], 'forced'), 'forced');
  assert.equal(slotOfMaterial('a_b_c', ['a', 'a_b']), 'a_b');
});

test('validateHumanoid reports, never throws', () => {
  assert.deepEqual(validateHumanoid({ base: 'b.glb', params: { height: 1.1 }, colors: { skin: '#fff' }, costume: { head: null }, bones: { head: 1.1 }, seed: 3 }), []);
  const bad = validateHumanoid({ base: 5, params: { nope: 1, height: 'x', build: 9 }, costume: { head: 3 }, colors: { skin: 'blue' }, bones: { head: 'big', tail: 2 }, seed: {} });
  assert.ok(bad.length >= 8, bad.join(' | '));
  assert.ok(bad.some((m) => /unknown param: nope/.test(m)));
  assert.ok(bad.some((m) => /outside/.test(m)));
  assert.ok(bad.some((m) => /not a canonical bone/.test(m)));
  assert.deepEqual(validateHumanoid(null), ['humanoid is not an object']);
});
