// r10-3: structural export cache — same node graph, different uniforms/textures => 1 builder run, per-material bindings correct.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture, uniform, float, vec3 } from 'three/tsl';
import { exportNodeMaterial, structCache } from '../client/kernel/render-api/tsl-export.js';
const tex = (v) => { const t = new THREE.DataTexture(new Uint8Array(16).fill(v), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const mk = (c, t, f, op = 1) => { const m = new THREE.MeshBasicNodeMaterial(); m.opacity = op; m.transparent = true; m.colorNode = texture(t).rgb.mul(uniform(new THREE.Color(c))).add(float(f)); return m; };
const reset = () => { for (const k of ['hits', 'misses', 'uncacheable', 'rebindFail', 'mismatch', 'verified']) structCache[k] = 0; structCache.map.clear(); structCache.log.length = 0; structCache.reasons = {}; };
// builder-side singleton uniforms (materialOpacity & co) need a 2nd build to be PROVEN shared before the key rebinds -> warm with 2 builds
const warm = (f = mk) => { exportNodeMaterial(f(0x111111, tex(1), 1), { THREE }); exportNodeMaterial(f(0x222222, tex(2), 1), { THREE }); for (const k of ['hits', 'misses']) structCache[k] = 0; };
const uni = (p) => p.bindGroups.flatMap((g) => g.bindings).filter((b) => b.uniforms).flatMap((b) => b.uniforms);
const tb = (p) => p.bindGroups.flatMap((g) => g.bindings).filter((b) => b.textureUuid);
test('same graph, different uniforms/textures -> 1 export, correct bindings', () => {
  reset(); warm();
  const t1 = tex(10), t2 = tex(200), a = mk(0xff0000, t1, 1, 0.5), b = mk(0x00ff00, t2, 1, 0.25);
  const pa = exportNodeMaterial(a, { THREE }), pb = exportNodeMaterial(b, { THREE });
  assert.equal(structCache.misses, 0); assert.equal(structCache.hits, 2, JSON.stringify(structCache.reasons) + structCache.log.join('|'));
  assert.equal(pa.fragment, pb.fragment);
  assert.equal(tb(pa)[0].textureUuid, t1.uuid); assert.equal(tb(pb)[0].textureUuid, t2.uuid);
  assert.equal(pb.textureSources[t2.uuid], t2); assert.equal(pb.textureSources[t1.uuid], undefined);
  const full = exportNodeMaterial(mk(0x00ff00, t2, 1, 0.25), { THREE, cache: 'off' }); // reference build
  const vals = (p) => uni(p).map((u) => (u.source?.kind === 'material' ? 'M' : JSON.stringify(u.value))).join(); // material-sourced uniforms (builder singletons) ship a stale value until live.update; compare the rest (robust to global singleton state left by other tests)
  // shared builder singleton (materialOpacity) ships the stale template value; the FIRST live.update must correct it to this material's 0.25
  const ch = pb.live.update({}); assert.ok(ch.some((c) => c.value === 0.25), JSON.stringify(ch));
  assert.equal(vals(pb), vals(full));
  // own live closure: mutate b's uniform, a must not see it
  assert.notDeepEqual(pa.live.keys, pb.live.keys);
  assert.ok(pa.live.update({}).some((c) => c.value === 0.5)); assert.deepEqual(pb.live.update({}), []);
});
test('verify mode: rebound == fully built', () => {
  reset(); warm();
  for (const [c, f] of [[0xff0000, 1], [0x00ff00, 1], [0x0000ff, 1]]) exportNodeMaterial(mk(c, tex(c % 255), f), { THREE, cache: 'verify' });
  assert.equal(structCache.mismatch, 0, structCache.log.join('|')); assert.equal(structCache.verified, 3);
});
test('different constant => different key (own build)', () => {
  reset();
  exportNodeMaterial(mk(0xff0000, tex(1), 1), { THREE }); exportNodeMaterial(mk(0xff0000, tex(1), 2), { THREE });
  assert.equal(structCache.misses, 2); assert.equal(structCache.hits, 0);
});
// the live closure of a rebound material tracks ITS OWN uniform node
test('live closure per material', () => {
  reset(); warm((c) => { const x = new THREE.MeshBasicNodeMaterial(); x.colorNode = uniform(new THREE.Color(c)).mul(float(2)); return x; });
  const u1 = uniform(new THREE.Color(1, 0, 0)), u2 = uniform(new THREE.Color(0, 1, 0));
  const m = (u) => { const x = new THREE.MeshBasicNodeMaterial(); x.colorNode = u.mul(float(2)); return x; };
  const p1 = exportNodeMaterial(m(u1), { THREE }), p2 = exportNodeMaterial(m(u2), { THREE });
  assert.equal(structCache.hits, 2);
  u2.value.set(0, 0, 1);
  assert.deepEqual(p1.live.update({}), []);
  const ch = p2.live.update({}); assert.equal(ch.length, 1); assert.deepEqual(ch[0].value, [0, 0, 1]); assert.equal(ch[0].key, u2.uuid);
});
// material-slot textures (material.map): builder creates the TextureNode itself -> rebind to THIS material's map + texture matrix
test('material.map slot rebinds + verify equal', () => {
  reset();
  const mkS = (c, t, rep) => { const m = new THREE.MeshStandardNodeMaterial(); m.map = t; t.repeat.set(rep, rep); t.updateMatrix(); m.color.set(c); m.roughness = 0.3 + rep / 10; m.colorNode = null; m.emissiveNode = uniform(new THREE.Color(c)); return m; };
  for (let i = 0; i < 4; i++) exportNodeMaterial(mkS(0x101010 * (i + 1), tex(i * 40), i + 1), { THREE, cache: 'verify' });
  assert.equal(structCache.mismatch, 0, structCache.log.join(' | ')); assert.ok(structCache.verified >= 2, JSON.stringify(structCache.reasons) + structCache.log.join('|'));
  const t5 = tex(99); t5.repeat.set(7, 7); t5.updateMatrix(); const p = exportNodeMaterial(mkS(0xabcdef, t5, 7), { THREE });
  assert.ok(structCache.hits >= 3);
  assert.equal(p.bindGroups.flatMap((g) => g.bindings).find((b) => b.textureUuid).textureUuid, t5.uuid);
  const mat = p.bindGroups.flatMap((g) => g.bindings).filter((b) => b.uniforms).flatMap((b) => b.uniforms).find((u) => u.value?.length === 9);
  assert.ok(mat && mat.value[0] === 7, JSON.stringify(mat));
});
